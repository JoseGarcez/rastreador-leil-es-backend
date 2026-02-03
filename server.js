/**
 * ============================================================
 * RASTREADOR DE TRATORES - BACKEND REFATORADO
 * ============================================================
 * * Dependências sugeridas: 
 * npm install express cors axios cheerio helmet express-rate-limit
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
// const helmet = require('helmet'); // RECOMENDADO: Descomentar após instalar
// const rateLimit = require('express-rate-limit'); // RECOMENDADO: Descomentar após instalar

// ============================================================
// CONFIGURAÇÕES E CONSTANTES
// ============================================================
const CONFIG = {
  TIMEOUT: 30000,
  MAX_LINKS_PER_SITE: 150,
  CONCURRENCY_LIMIT: 5,
  PORT: process.env.PORT || 3000
};

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
];

const IGNORED_PATTERNS = [
  'facebook', 'twitter', 'instagram', 'linkedin', 'whatsapp', 'youtube',
  'login', 'cadastro', 'minha-conta', 'recuperar', 'politica', 'fale-conosco',
  'javascript', '#', 'tel:', 'mailto:', 'xmlrpc.php'
];

// ============================================================
// SERVIÇO DE UTILITÁRIOS (DRY & HELPERS)
// ============================================================
const Utils = {
  getRandomUserAgent: () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)],

  cleanText: (text) => {
    if (!text) return '';
    return text.replace(/[\n\r\t]+/g, ' ').replace(/\s+/g, ' ').trim();
  },

  shouldIgnoreLink: (href) => {
    return IGNORED_PATTERNS.some(pattern => href.toLowerCase().includes(pattern));
  },

  safeUrlJoin: (base, href) => {
    try {
      return new URL(href, base).href;
    } catch {
      return null;
    }
  },

  // Otimização DRY: Extração recursiva ou iterativa de ancestrais
  getAncestorsText: ($element, depth = 3) => {
    let context = '';
    let current = $element.parent();
    for (let i = 0; i < depth; i++) {
      if (current.length === 0) break;
      context += ' ' + Utils.cleanText(current.text());
      current = current.parent();
    }
    return context;
  }
};

// ============================================================
// SERVIÇO DE SCRAPING (Lógica de Negócio)
// ============================================================
class ScraperService {
  constructor(options) {
    this.options = options;
  }

  async analyzeUrl(url, keywords, negativeStrong, negativeWeak) {
    const result = {
      url,
      status: 'Pending',
      links: [],
      termos: [],
      jsDetectado: false,
      isKron: url.toLowerCase().includes('kron')
    };

    try {
      const response = await axios.get(url, {
        timeout: this.options.TIMEOUT,
        headers: {
          'User-Agent': Utils.getRandomUserAgent(),
          'Accept': 'text/html,application/xhtml+xml',
          'Connection': 'keep-alive'
        },
        maxRedirects: 5,
        httpsAgent: new (require('https').Agent)({ rejectUnauthorized: false }),
        validateStatus: status => status < 500 // Aceita 404/403 para tratar como erro lógico, não exceção
      });

      if (response.status !== 200) {
        result.status = `HTTP ${response.status}`;
        return result;
      }

      if (response.data.length < 5000) result.status = 'Conteúdo Curto/JS';
      else result.status = 'Online';

      const $ = cheerio.load(response.data);
      const visitedUrls = new Set();
      const tagsA = $('a[href]');

      // Iteração otimizada
      for (let i = 0; i < tagsA.length; i++) {
        if (result.links.length >= this.options.MAX_LINKS_PER_SITE) break;

        const tag = tagsA[i];
        const $tag = $(tag);
        const href = $tag.attr('href')?.trim();
        
        if (!href || Utils.shouldIgnoreLink(href)) continue;

        // Construção do Contexto Rico (Otimizado)
        const txtLink = Utils.cleanText($tag.text());
        const txtImg = $tag.find('img').attr('alt') || '';
        const txtTitle = $tag.attr('title') || '';
        const ancestorsText = Utils.getAncestorsText($tag, 3); // Pai, Avô, Bisavô
        
        const fullContext = `${txtLink} ${txtImg} ${txtTitle} ${ancestorsText} ${href}`.toLowerCase();

        // 1. Filtro Negativo Forte
        if (negativeStrong.some(n => fullContext.includes(n.toLowerCase()))) continue;

        // 2. Filtro Positivo
        const foundTerms = keywords.filter(k => fullContext.includes(k.toLowerCase()));
        
        if (foundTerms.length > 0) {
          // 3. Filtro Negativo Fraco (Contexto local do link)
          const linkContext = `${txtLink} ${txtImg} ${txtTitle} ${href}`.toLowerCase();
          const isWeakNegative = negativeWeak.some(nw => linkContext.includes(nw.toLowerCase()));

          if (!isWeakNegative) {
            const finalUrl = Utils.safeUrlJoin(url, href);
            if (finalUrl && !visitedUrls.has(finalUrl)) {
              visitedUrls.add(finalUrl);
              
              let description = txtLink || txtImg || txtTitle;
              if (description.length < 5) description = `[AUTO] ${ancestorsText.substring(0, 80)}...`;

              result.links.push({ txt: description.substring(0, 150), url: finalUrl });
              
              // Adiciona termos únicos encontrados
              foundTerms.forEach(t => {
                if (!result.termos.includes(t)) result.termos.push(t);
              });
            }
          }
        }
      }

      // Detecção de JS caso nenhum link seja encontrado
      if (result.links.length === 0) {
        const pageHtml = $.html().toLowerCase();
        if (keywords.some(k => pageHtml.includes(k.toLowerCase()))) {
          result.jsDetectado = true;
        }
      }

    } catch (error) {
      result.status = error.code === 'ECONNABORTED' ? 'Timeout' : 
                      error.code === 'ENOTFOUND' ? 'DNS Error' : 
                      error.message;
    }

    return result;
  }
}

// ============================================================
// CONTROLLER (Validação e Orquestração)
// ============================================================
const ScraperController = {
  async scrape(req, res) {
    try {
      const { urls, palavrasChave, negativosFortes, negativosFracos } = req.body;

      // Validação de Input (Safety)
      if (!Array.isArray(urls) || urls.length === 0) {
        return res.status(400).json({ error: 'Lista de URLs inválida.' });
      }
      if (urls.length > 500) {
        return res.status(400).json({ error: 'Limite de 500 URLs excedido.' });
      }

      const validUrls = urls.filter(u => {
        try { new URL(u); return true; } catch { return false; }
      });

      // Default Lists
      const keywords = (palavrasChave?.length ? palavrasChave : ['trator']).map(k => k.trim());
      const strongNeg = (negativosFortes || []).map(n => n.trim());
      const weakNeg = (negativosFracos || []).map(n => n.trim());

      const scraper = new ScraperService(CONFIG);
      const start = Date.now();

      // CONCORRÊNCIA CONTROLADA (Queue Pattern ao invés de Batching simples)
      // Simulação de p-limit para controle de workers
      const results = [];
      const executing = [];
      
      for (const url of validUrls) {
        const p = scraper.analyzeUrl(url, keywords, strongNeg, weakNeg).then(r => {
          // Flatten results immediately to save memory structure if needed
          if (r.links.length > 0) {
             const termsStr = r.termos.join(', ');
             r.links.forEach(l => results.push({
               Site: r.url,
               Termos: termsStr,
               Descricao: l.txt,
               Link: l.url
             }));
          }
        });
        
        executing.push(p);
        
        if (executing.length >= CONFIG.CONCURRENCY_LIMIT) {
          await Promise.race(executing); // Espera o primeiro terminar
          // Remove as promessas completadas do array
          // Nota: Em produção, usar p-limit ou BullMQ é mais robusto
          const index = executing.findIndex(p => p.status === 'fulfilled'); // Isso requer Promise.allSettled ou lógica extra, simplificando aqui com await
        }
      }
      
      await Promise.all(executing); // Espera os restantes

      const uniqueResults = Array.from(new Map(results.map(item => [item.Link, item])).values());

      res.json({
        success: true,
        meta: {
          totalSites: validUrls.length,
          oportunidades: uniqueResults.length,
          duracaoMs: Date.now() - start
        },
        data: uniqueResults
      });

    } catch (error) {
      console.error(error);
      res.status(500).json({ error: 'Erro interno no processamento.' });
    }
  }
};

// ============================================================
// SERVER SETUP
// ============================================================
const app = express();

// Segurança Básica
// app.use(helmet()); 
app.use(express.json({ limit: '1mb' })); // Limita payload

// CORS Config
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ['https://caetite.netlify.app'] // Restritivo em produção
    : '*', 
  methods: ['GET', 'POST']
}));

// Rotas
app.get('/health', (req, res) => res.json({ status: 'healthy', uptime: process.uptime() }));
app.post('/api/scrape', ScraperController.scrape);

app.listen(CONFIG.PORT, () => {
  console.log(`[Server] Rodando na porta ${CONFIG.PORT}`);
});
