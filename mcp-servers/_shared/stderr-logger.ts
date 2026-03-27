export interface LoggerInterface {
  debug(message: string, data?: any): void;
  info(message: string, data?: any): void;
  warn(message: string, data?: any): void;
  error(message: string, error?: any): void;
}

export class StderrLogger implements LoggerInterface {
  private context: string;

  constructor(context: string) {
    this.context = context;
  }

  private formatMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const prefix = `[${timestamp}] [${level}] [${this.context}]`;
    
    if (data) {
      return `${prefix} ${message}\n${JSON.stringify(data, null, 2)}`;
    }
    return `${prefix} ${message}`;
  }

  debug(message: string, data?: any) {
    // Only output debug messages if DEBUG environment variable is set
    if (process.env.DEBUG) {
      process.stderr.write(this.formatMessage('DEBUG', message, data) + '\n');
    }
  }

  info(message: string, data?: any) {
    process.stderr.write(this.formatMessage('INFO', message, data) + '\n');
  }

  warn(message: string, data?: any) {
    process.stderr.write(this.formatMessage('WARN', message, data) + '\n');
  }

  error(message: string, error?: any) {
    const errorData = error instanceof Error ? {
      errorMessage: error.message,
      stack: error.stack,
      ...error
    } : error;
    process.stderr.write(this.formatMessage('ERROR', message, errorData) + '\n');
  }
}