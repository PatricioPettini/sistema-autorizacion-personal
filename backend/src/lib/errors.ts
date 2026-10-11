/** Error de aplicación con código HTTP y mensaje apto para el usuario final. */
export class AppError extends Error {
  statusCode: number;
  publicMessage: string;
  constructor(statusCode: number, publicMessage: string, internal?: string) {
    super(internal ?? publicMessage);
    this.statusCode = statusCode;
    this.publicMessage = publicMessage;
  }
}

export const badRequest = (msg: string) => new AppError(400, msg);
export const unauthorized = (msg = 'Necesitás iniciar sesión.') => new AppError(401, msg);
export const forbidden = (msg = 'No tenés permisos para esta acción.') => new AppError(403, msg);
export const notFound = (msg = 'No se encontró el recurso solicitado.') => new AppError(404, msg);
export const conflict = (msg: string) => new AppError(409, msg);
export const tooManyRequests = (msg = 'Demasiados intentos. Esperá unos minutos e intentá de nuevo.') => new AppError(429, msg);
