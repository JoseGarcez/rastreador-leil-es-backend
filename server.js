/**
 * ============================================================
 * RASTREADOR DE TRATORES - BACKEND (Node.js + Express)
 * ============================================================
 * 
 * Deploy: Render.com (ou qualquer serviço Node.js)
 * 
 * INSTRUÇÕES DE DEPLOY NO RENDER.COM:
 * 1. Crie uma conta em https://render.com
 * 2. Clique em "New +" → "Web Service"
 * 3. Conecte seu repositório GitHub/GitLab ou faça upload manual
 * 4. Configure:
 *    - Name: rastreador-tratores-api
 *    - Runtime: Node
 *    - Build Command: npm install
 *    - Start Command: npm start
 * 5. Clique em "Create Web Service"
 * 
 * ============================================================
 */

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================================
// CONFIGURAÇÃO DE CORS
// ============================================================
// OPÇÃO 1: Permitir qualquer origem (desenvolvimento)
app.use(cors());

// OPÇÃO 2: Restringir para domínio específico (produção)
// Substitua pela URL do seu frontend na Netlify
/*
app.use(cors({
  origin: [
    'https://seu-site.netlify.app',  // Substitua pela sua URL da Netlify
    'http://localhost:5500',          // Para testes locais
    'http://127.0.0.1:5500'
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
*/

app.use(express.json());

// ============================================================
// CONFIGURAÇÕES DO SCRAPER (Baseado no rastreador_tratores_v6.py)
// ============================================================
const CONFIG = {
  TIMEOUT: 30000,           // 30 segundos
  MAX_LINKS_PER_SITE: 150,  // Limite de links por site
  MAX_WORKERS: 5            // Número máximo de requisições simultâneas
};

// User Agents para rotacionar
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.3 Safari/605.1.15',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0'
];

// Links ignorados (navegação, redes sociais, etc.)
const LINKS_IGNORADOS = [
  'facebook', 'twitter', 'instagram', 'linkedin', 'whatsapp', 
  'youtube', 'login', 'cadastro', 'minha-conta', 'recuperar', 
  'politica', 'fale-conosco', 'contato', 'institucional', 
  'javascript', '#', 'tel:', 'mailto:', 'print', 'footer', 'header',
  'wp-content', 'wp-includes', 'wp-json', 'xmlrpc.php'
];

// ============================================================
// FUNÇÕES AUXILIARES
// ============================================================

/**
 * Retorna um User-Agent aleatório
 */
function getRandomUserAgent() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

/**
 * Limpa e normaliza o texto
 */
function limparTexto(texto) {
  if (!texto) return '';
  return texto
    .replace(/[\n\r\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Verifica se um link deve ser ignorado
 */
function deveIgnorarLink(href) {
  const hrefLower = href.toLowerCase();
  return LINKS_IGNORADOS.some(ignorado => hrefLower.includes(ignorado));
}

/**
 * Constrói URL absoluta a partir de uma relativa
 */
function urljoin(base, href) {
  try {
    return new URL(href, base).href;
  } catch {
    return null;
  }
}

/**
 * Verifica se é um site Kron Leilões (lógica especial)
 */
function isKronLeiloes(url) {
  return url.toLowerCase().includes('kron');
}

// ============================================================
// LÓGICA PRINCIPAL DE SCRAPING (Replica do Python)
// ============================================================

/**
 * Analisa um único site em busca de tratores
 */
async function analisarSite(url, palavrasChave, negativosFortes, negativosFracos) {
  const resultado = {
    url: url,
    status: 'Erro',
    links: [],
    termos: [],
    jsDetectado: false,
    isKron: isKronLeiloes(url)
  };

  try {
    // Configuração da requisição
    const config = {
      timeout: CONFIG.TIMEOUT,
      headers: {
        'User-Agent': getRandomUserAgent(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
        'Referer': 'https://www.google.com/',
        'Connection': 'keep-alive'
      },
      // Não seguir redirects automaticamente para evitar loops
      maxRedirects: 5,
      // Ignorar erros de certificado SSL (alguns sites de leilão têm certificados problemáticos)
      httpsAgent: new (require('https').Agent)({
        rejectUnauthorized: false
      })
    };

    const response = await axios.get(url, config);

    // Verificar se o conteúdo é muito pequeno (possível conteúdo JS)
    if (response.data.length < 5000) {
      resultado.status = 'Conteúdo Oculto/JS';
    }

    if (response.status === 200) {
      resultado.status = 'Online';
      const $ = cheerio.load(response.data);
      
      // Conjunto para evitar links duplicados
      const urlsVistas = new Set();
      
      // --- VARREDURA HÍBRIDA (V6.1) ---
      const tagsA = $('a[href]');
      
      tagsA.each((_, tag) => {
        // Limite de links atingido
        if (resultado.links.length >= CONFIG.MAX_LINKS_PER_SITE) {
          return false; // break do each
        }

        const $tag = $(tag);
        const href = $tag.attr('href').trim();
        const hrefLower = href.toLowerCase();
        
        // 1. Filtro Rápido de Lixo
        if (deveIgnorarLink(href)) return;

        // 2. Construção do "Contexto Rico" (AMPLIADO)
        // Pega texto do link + texto do pai + texto do avô + BISAVÔ + atributos
        const txtLink = limparTexto($tag.text());
        const txtImg = $tag.find('img').attr('alt') || '';
        const txtTitle = $tag.attr('title') || '';
        
        // Sobe 3 níveis na hierarquia para garantir que pegamos o título do Card
        const txtPai = $tag.parent().text() ? limparTexto($tag.parent().text()) : '';
        const txtAvo = $tag.parent().parent().text() ? limparTexto($tag.parent().parent().text()) : '';
        const txtBisavo = $tag.parent().parent().parent().text() ? limparTexto($tag.parent().parent().parent().text()) : '';
        
        // Monta a string gigante de análise
        const contextoFull = `${txtLink} ${txtImg} ${txtTitle} ${txtPai} ${txtAvo} ${txtBisavo} ${hrefLower}`.toLowerCase();
        
        // --- LÓGICA DE FILTRO INTELIGENTE ---
        
        // A. Verifica Negativos FORTES (Mata imediatamente)
        const temNegativoForte = negativosFortes.some(nf => contextoFull.includes(nf.toLowerCase()));
        if (temNegativoForte) return;

        // B. Verifica Positivos (Tem trator?)
        const temTrator = palavrasChave.some(pos => contextoFull.includes(pos.toLowerCase()));
        
        if (temTrator) {
          // C. Verifica Negativos FRACOS
          const linkEspecifico = `${txtLink} ${txtImg} ${txtTitle} ${hrefLower}`.toLowerCase();
          const ehManualOuPeca = ['manual', 'catalogo', 'catálogo', 'peça', 'peca', 'sucata', 'pneu', 'pneus'].some(
            nf => linkEspecifico.includes(nf)
          );
          
          if (!ehManualOuPeca) {
            const urlFinal = urljoin(url, href);
            if (urlFinal && !urlsVistas.has(urlFinal)) {
              urlsVistas.add(urlFinal);
              
              // Melhora a descrição
              let desc = txtLink || txtImg || txtTitle;
              const descLower = desc.toLowerCase();
              if (desc.length < 4 || ['ver', 'lote', 'clique', 'detalhes', 'saiba mais', 'veja mais'].includes(descLower)) {
                desc = `[AUTO] ${txtPai.substring(0, 80)}...`;
              }
              
              resultado.links.push({
                txt: desc.substring(0, 150),
                url: urlFinal
              });
              
              // Registra os termos encontrados
              palavrasChave.forEach(p => {
                if (contextoFull.includes(p.toLowerCase()) && !resultado.termos.includes(p)) {
                  resultado.termos.push(p);
                }
              });
            }
          }
        }
      });

      // --- DETECÇÃO DE SCRIPT OCULTO ---
      if (resultado.links.length === 0) {
        const scripts = $('script');
        scripts.each((_, script) => {
          const scriptContent = $(script).html() || '';
          if (palavrasChave.some(p => scriptContent.toLowerCase().includes(p.toLowerCase()))) {
            resultado.jsDetectado = true;
            return false; // break
          }
        });
      }
    } else {
      resultado.status = `HTTP ${response.status}`;
    }

  } catch (error) {
    // Tratamento específico de erros
    if (error.code === 'ECONNABORTED') {
      resultado.status = 'Timeout';
    } else if (error.code === 'ENOTFOUND') {
      resultado.status = 'DNS não encontrado';
    } else if (error.code === 'ECONNREFUSED') {
      resultado.status = 'Conexão recusada';
    } else if (error.response) {
      resultado.status = `HTTP ${error.response.status}`;
    } else {
      resultado.status = 'Erro Conexão';
    }
  }

  return resultado;
}

/**
 * Processa múltiplos sites com controle de concorrência
 */
async function processarSites(urls, palavrasChave, negativosFortes, negativosFracos, progressCallback) {
  const resultados = [];
  const total = urls.length;
  let processados = 0;

  // Processa em lotes para controlar concorrência
  for (let i = 0; i < urls.length; i += CONFIG.MAX_WORKERS) {
    const lote = urls.slice(i, i + CONFIG.MAX_WORKERS);
    
    const promessas = lote.map(async (url) => {
      const resultado = await analisarSite(url, palavrasChave, negativosFortes, negativosFracos);
      processados++;
      
      // Callback de progresso
      if (progressCallback) {
        progressCallback({
          atual: processados,
          total: total,
          url: url,
          encontrados: resultado.links.length,
          isKron: resultado.isKron,
          jsDetectado: resultado.jsDetectado
        });
      }
      
      return resultado;
    });

    const resultadosLote = await Promise.all(promessas);
    
    // Filtra e formata os resultados
    resultadosLote.forEach(res => {
      if (res.links.length > 0) {
        const termosStr = res.termos.join(', ');
        res.links.forEach(link => {
          resultados.push({
            Site: res.url,
            Termos: termosStr,
            Descricao: link.txt,
            Link: link.url
          });
        });
      }
    });
  }

  // Remove duplicados e ordena
  const linksUnicos = new Map();
  resultados.forEach(r => {
    if (!linksUnicos.has(r.Link)) {
      linksUnicos.set(r.Link, r);
    }
  });

  return Array.from(linksUnicos.values()).sort((a, b) => {
    if (a.Site !== b.Site) return a.Site.localeCompare(b.Site);
    return a.Descricao.localeCompare(b.Descricao);
  });
}

// ============================================================
// ROTAS DA API
// ============================================================

/**
 * Rota de health check
 */
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    message: 'Rastreador de Tratores API',
    version: '1.0.0',
    endpoints: {
      health: 'GET /health',
      scrape: 'POST /api/scrape'
    }
  });
});

/**
 * Health check detalhado
 */
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

/**
 * Rota principal de scraping
 * POST /api/scrape
 * 
 * Body:
 * {
 *   urls: string[],           // Lista de URLs para analisar
 *   palavrasChave: string[],  // Palavras-chave positivas (opcional)
 *   negativosFortes: string[], // Palavras que bloqueiam sempre (opcional)
 *   negativosFracos: string[]  // Palavras que bloqueiam contextualmente (opcional)
 * }
 */
app.post('/api/scrape', async (req, res) => {
  try {
    const { 
      urls = [], 
      palavrasChave = [],
      negativosFortes = [],
      negativosFracos = []
    } = req.body;

    // Validações
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'A lista de URLs é obrigatória e não pode estar vazia'
      });
    }

    // Validação de URLs
    const urlsValidas = urls.filter(u => {
      try {
        new URL(u);
        return true;
      } catch {
        return false;
      }
    });

    if (urlsValidas.length === 0) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Nenhuma URL válida foi fornecida'
      });
    }

    // Valida limite de URLs (proteção contra abuse)
    if (urlsValidas.length > 500) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Limite máximo de 500 URLs excedido'
      });
    }

    // Valida limite de palavras-chave
    if (palavrasChave.length > 50) {
      return res.status(400).json({
        error: 'Bad Request',
        message: 'Limite máximo de 50 palavras-chave excedido'
      });
    }

    // Palavras-chave padrão (do script Python original)
    const palavrasChavePadrao = [
      'trator', 'tratores', 
      'massey ferguson', 'john deere', 'valtra', 'valmet', 
      'new holland', 'case ih', 'agrícola', 'agricola',
      'retroescavadeira', 'pá carregadeira', 'motocana',
      'plantadeira', 'colheitadeira', 'esteira', 'motoniveladora'
    ];

    // Negativos fortes padrão
    const negativosFortesPadrao = [
      'scania', 'iveco', 'daf', 'constellation', 'vw delivery', 'vw worker',
      'mercedes benz', 'volvo fh', 'volvo vm', 'onibus', 'ônibus', 'bus', 
      'micro-onibus', 'carcaça', 'sucata de ferro', 'sucata de motor'
    ];

    // Negativos fracos padrão
    const negativosFracosPadrao = [
      'caminhão', 'caminhao', 'truck', 'cavalo mecânico', 
      'lote de pneu', 'jogo de pneu', 'pneus soltos', 
      'lote de peças', 'caixa de peças', 'manual do proprietário', 
      'catálogo', 'edital', 'condições de venda'
    ];

    // Usa as palavras fornecidas ou as padrão
    const palavrasChaveFinais = palavrasChave.length > 0 ? palavrasChave : palavrasChavePadrao;
    const negativosFortesFinais = negativosFortes.length > 0 ? negativosFortes : negativosFortesPadrao;
    const negativosFracosFinais = negativosFracos.length > 0 ? negativosFracos : negativosFracosPadrao;

    console.log(`[${new Date().toISOString()}] Iniciando scraping de ${urlsValidas.length} sites`);
    console.log(`Palavras-chave: ${palavrasChaveFinais.join(', ')}`);

    const inicio = Date.now();

    // Processa os sites
    const resultados = await processarSites(
      urlsValidas, 
      palavrasChaveFinais, 
      negativosFortesFinais, 
      negativosFracosFinais,
      (progresso) => {
        // Log de progresso no servidor
        const prefixo = `[${progresso.atual}/${progresso.total}]`;
        if (progresso.isKron) {
          const status = progresso.encontrados > 0 
            ? `✅ ${progresso.encontrados} links` 
            : (progresso.jsDetectado ? '⚠️ DETECTADO NO CÓDIGO (JS)' : '❌ NADA');
          console.log(`${prefixo} KRON LEILÕES: ${status}`);
        } else if (progresso.encontrados > 0) {
          console.log(`${prefixo} ✅ ${progresso.url} -> ${progresso.encontrados} encontrados`);
        } else if (progresso.jsDetectado) {
          console.log(`${prefixo} ⚠️ ${progresso.url} -> Conteúdo em JS (Invisível p/ robô simples)`);
        }
      }
    );

    const duracao = Date.now() - inicio;

    console.log(`[${new Date().toISOString()}] Scraping concluído em ${duracao}ms. ${resultados.length} oportunidades encontradas.`);

    // Retorna os resultados
    res.json({
      success: true,
      meta: {
        totalSites: urlsValidas.length,
        sitesProcessados: urlsValidas.length,
        oportunidadesEncontradas: resultados.length,
        duracaoMs: duracao,
        palavrasChaveUsadas: palavrasChaveFinais
      },
      data: resultados
    });

  } catch (error) {
    console.error('Erro no scraping:', error);
    res.status(500).json({
      error: 'Internal Server Error',
      message: 'Ocorreu um erro ao processar a requisição',
      details: process.env.NODE_ENV === 'development' ? error.message : undefined
    });
  }
});

// ============================================================
// TRATAMENTO DE ERROS
// ============================================================

// 404 - Rota não encontrada
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    message: `Rota ${req.method} ${req.path} não encontrada`
  });
});

// 500 - Erro interno
app.use((err, req, res, next) => {
  console.error('Erro não tratado:', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: 'Ocorreu um erro interno no servidor'
  });
});

// ============================================================
// INICIALIZAÇÃO DO SERVIDOR
// ============================================================

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('RASTREADOR DE TRATORES - BACKEND');
  console.log('='.repeat(60));
  console.log(`Servidor rodando na porta: ${PORT}`);
  console.log(`Ambiente: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Health Check: http://localhost:${PORT}/health`);
  console.log(`API Endpoint: http://localhost:${PORT}/api/scrape`);
  console.log('='.repeat(60));
});

module.exports = app; // Para testes
