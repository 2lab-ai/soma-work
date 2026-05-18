import path from 'node:path';

export const DATA_DIR = process.env.SOMA_DATA_DIR || path.join(process.cwd(), 'data');
