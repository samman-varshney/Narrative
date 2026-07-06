import { IStorageProvider } from './IStorageProvider';
import fs from 'fs/promises';
import path from 'path';

// Scaffolded local storage provider for development
// In production, this would be replaced with CloudinaryProvider or S3Provider
export class LocalStorageProvider implements IStorageProvider {
  private readonly uploadDir = path.join(process.cwd(), 'uploads');

  constructor() {
    // Ensure upload directory exists
    fs.mkdir(this.uploadDir, { recursive: true }).catch(console.error);
  }

  async upload(buffer: Buffer, filename: string, mimetype: string): Promise<string> {
    const uniqueFilename = `${Date.now()}-${filename}`;
    const filePath = path.join(this.uploadDir, uniqueFilename);
    await fs.writeFile(filePath, buffer);
    
    // Return a mock URL that would ideally map to a static Express route
    return `/uploads/${uniqueFilename}`;
  }

  async delete(identifier: string): Promise<void> {
    const filename = identifier.replace('/uploads/', '');
    const filePath = path.join(this.uploadDir, filename);
    
    try {
      await fs.unlink(filePath);
    } catch (error) {
      // Ignore if file doesn't exist
    }
  }
}

export const storageProvider = new LocalStorageProvider();
