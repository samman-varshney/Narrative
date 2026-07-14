export interface EditorMetadata {
  wordCount: number;
  charCount: number;
  readingTimeMinutes: number;
  plainText: string;
  /** Number of heading nodes (`type: 'heading'`). */
  headingCount: number;
  /** Number of image nodes (`type: 'image'`). */
  imageCount: number;
  /** Number of code-block nodes (`type: 'codeBlock'`). */
  codeBlockCount: number;
}

export interface IEditorParser {
  /**
   * Parses the raw editor content and returns metadata like word count and reading time.
   */
  extractMetadata(content: any): EditorMetadata;

  /**
   * Sanitizes the editor content to prevent XSS or invalid structures.
   */
  sanitize(content: any): any;
}
