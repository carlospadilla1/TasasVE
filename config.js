/* ============================================================
 * Tasas Venezuela · Configuración
 * Edita este archivo para cambiar el endpoint, la API key
 * o las preferencias de actualización. Nada más que tocar.
 *
 * ⚠️ SEGURIDAD: en producción real, mueve la API key a un
 * proxy/backend y deja apiKey: ''. Ver README.md.
 * ============================================================ */
window.TASAS_CONFIG = {
  // Endpoint de la API de Cotizave (consulta completa)
  endpoint: 'https://api.cotizave.com/v1/fx/rates',

  // API key (header X-API-Key). Deja '' si consumes un proxy propio.
  apiKey: '',

  // Ciclo de actualización automática (5 minutos)
  pollMs: 5 * 60 * 1000,

  // Zona horaria para fechas y horas (hora de Caracas)
  tz: 'America/Caracas',
};
