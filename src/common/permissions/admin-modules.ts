/**
 * Módulos disponibles para asignar a administradores por hotel.
 *
 * - inbox      → ver, filtrar y asignar conversaciones de la bandeja
 * - mail       → enviar y responder emails desde la casilla del hotel
 * - templates  → crear, editar y usar templates del hotel
 * - config     → ver la configuración del hotel (tono, firma, reglas IA)
 */
export const ADMIN_MODULES = ['inbox', 'mail', 'templates', 'config'] as const;

export type AdminModule = (typeof ADMIN_MODULES)[number];
