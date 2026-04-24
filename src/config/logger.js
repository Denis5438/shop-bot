const winston = require('winston');

const baseFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.splat()
);

const humanFormat = winston.format.printf(({ timestamp, level, message, stack, ...meta }) => {
  const extras = Object.keys(meta).length > 0 ? ` ${JSON.stringify(meta)}` : '';
  const body = stack || message;
  return `[${timestamp}] ${level}: ${body}${extras}`;
});

const logger = winston.createLogger({
  level: 'info',
  transports: [
    new winston.transports.Console({
      format: winston.format.combine(
        baseFormat,
        winston.format.colorize(),
        humanFormat
      ),
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      format: winston.format.combine(baseFormat, humanFormat),
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
      format: winston.format.combine(baseFormat, humanFormat),
    }),
  ],
});

module.exports = logger;
