export interface IStorageProvider {
  /**
   * Uploads a file buffer and returns the public URL.
   * @param buffer The file content buffer
   * @param filename Desired filename or path
   * @param mimetype The MIME type of the file
   * @returns The public URL of the uploaded file
   */
  upload(buffer: Buffer, filename: string, mimetype: string): Promise<string>;

  /**
   * Deletes a file by its public URL or identifier.
   * @param identifier The public URL or internal identifier
   */
  delete(identifier: string): Promise<void>;
}
