import logger from './logger';

export class CustomError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number, isOperational = true) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

export class BadRequestError extends CustomError {
  constructor(message = 'Bad Request') {
    super(message, 400);
  }
}

export class UnauthorizedError extends CustomError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

export class ForbiddenError extends CustomError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

export class NotFoundError extends CustomError {
  constructor(message = 'Not Found') {
    super(message, 404);
  }
}

export class ConflictError extends CustomError {
  constructor(message = 'Conflict') {
    super(message, 409);
  }
}

export class InternalServerError extends CustomError {
  constructor(message = 'Internal Server Error') {
    super(message, 500, false);
  }
}

export const isOperationalError = (error: Error): boolean => {
  if (error instanceof CustomError) {
    return error.isOperational;
  }
  return false;
};

export const handleError = (error: Error): void => {
  logger.error('Error:', error);

  if (!isOperationalError(error)) {
    // For non-operational errors, you might want to do some additional logging
    // or perhaps exit the process in a production environment
    logger.error('Non-operational error occurred:', error);
    // process.exit(1);
  }
};
