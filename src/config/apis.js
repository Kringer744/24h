require('dotenv').config();

module.exports = {
  pacto: {
    apiKey: process.env.PACTO_API_KEY,
    gatewayUrl: process.env.PACTO_GATEWAY_URL,
    personagemUrl: process.env.PACTO_PERSONAGEM_URL,
    authUrl: process.env.PACTO_AUTH_URL,
    sinteticoUrl: process.env.PACTO_SINTETICO_URL,
    marketingUrl: process.env.PACTO_MARKETING_URL,
    unidadeChave: process.env.PACTO_UNIDADE_CHAVE,
    empresaId: process.env.PACTO_EMPRESA_ID || '4',
    unidadeId: process.env.PACTO_UNIDADE_ID || '4',
  },
  uazapi: {
    baseUrl:       process.env.UAZAPI_BASE_URL,
    adminToken:    process.env.UAZAPI_ADMIN_TOKEN,
    instanceToken: process.env.UAZAPI_INSTANCE_TOKEN,
    instanceName:  process.env.UAZAPI_INSTANCE_NAME,
  },
};
