import { promises as fs } from 'fs';
import { v4 as uuidv4 } from 'uuid';

export async function withTempFile(buffer, extension, callback) {
  const tempPath = `./temp_${uuidv4()}.${extension}`;
  try {
    await fs.writeFile(tempPath, buffer);
    return await callback(tempPath);
  } finally {
    try {
      await fs.unlink(tempPath);
    } catch (cleanupError) {
      console.warn(`⚠️ Falha ao limpar arquivo temporário ${tempPath}:`, cleanupError);
    }
  }
}