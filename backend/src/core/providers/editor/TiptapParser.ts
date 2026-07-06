import { IEditorParser, EditorMetadata } from './IEditorParser';

export class TiptapParser implements IEditorParser {
  // Average reading speed: 200-250 words per minute
  private readonly WORDS_PER_MINUTE = 225;

  extractMetadata(content: any): EditorMetadata {
    if (!content || typeof content !== 'object') {
      return { wordCount: 0, charCount: 0, readingTimeMinutes: 0, plainText: '' };
    }

    const plainText = this.extractTextRecursively(content);
    
    // Calculate character count
    const charCount = plainText.length;
    
    // Calculate word count
    const words = plainText.trim().split(/\s+/);
    const wordCount = plainText.trim() === '' ? 0 : words.length;

    // Calculate reading time
    const readingTimeMinutes = Math.ceil(wordCount / this.WORDS_PER_MINUTE);

    return {
      wordCount,
      charCount,
      readingTimeMinutes,
      plainText,
    };
  }

  sanitize(content: any): any {
    // A robust sanitizer would validate against the specific ProseMirror schema.
    // For V1, we ensure the root is a document and recursively escape raw HTML in text nodes.
    if (!content || typeof content !== 'object' || content.type !== 'doc') {
      return { type: 'doc', content: [] };
    }

    return this.sanitizeNode(content);
  }

  private extractTextRecursively(node: any): string {
    if (!node || typeof node !== 'object') return '';

    let text = '';
    
    if (node.type === 'text' && typeof node.text === 'string') {
      text += node.text;
    }

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        text += this.extractTextRecursively(child);
      }
    }

    // Add spaces after block nodes like paragraphs or headings
    if (['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem'].includes(node.type)) {
      text += ' ';
    }

    return text;
  }

  private sanitizeNode(node: any): any {
    if (!node || typeof node !== 'object') return node;

    const sanitized = { ...node };

    if (sanitized.type === 'text' && typeof sanitized.text === 'string') {
      // Basic escaping of < and > to prevent raw HTML execution if the frontend renders unsafely
      sanitized.text = sanitized.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    if (Array.isArray(sanitized.content)) {
      sanitized.content = sanitized.content.map((child: any) => this.sanitizeNode(child));
    }

    return sanitized;
  }
}

export const editorParser = new TiptapParser();
