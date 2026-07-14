import { IEditorParser, EditorMetadata } from './IEditorParser';

export class TiptapParser implements IEditorParser {
  // Average reading speed: 200-250 words per minute
  private readonly WORDS_PER_MINUTE = 225;

  // URL schemes that must never survive sanitization (stored-XSS vectors).
  private readonly DANGEROUS_URL = /^\s*(javascript|data|vbscript):/i;

  extractMetadata(content: any): EditorMetadata {
    if (!content || typeof content !== 'object') {
      return {
        wordCount: 0,
        charCount: 0,
        readingTimeMinutes: 0,
        plainText: '',
        headingCount: 0,
        imageCount: 0,
        codeBlockCount: 0,
      };
    }

    const plainText = this.extractTextRecursively(content);

    // Calculate character count
    const charCount = plainText.length;

    // Calculate word count
    const words = plainText.trim().split(/\s+/);
    const wordCount = plainText.trim() === '' ? 0 : words.length;

    // Calculate reading time
    const readingTimeMinutes = Math.ceil(wordCount / this.WORDS_PER_MINUTE);

    // Structural node counts (single recursive pass over the doc tree).
    const counts = { heading: 0, image: 0, codeBlock: 0 };
    this.countNodes(content, counts);

    return {
      wordCount,
      charCount,
      readingTimeMinutes,
      plainText,
      headingCount: counts.heading,
      imageCount: counts.image,
      codeBlockCount: counts.codeBlock,
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

  /**
   * Recursively tallies structural node types (headings, images, code blocks)
   * across the whole document tree in a single pass.
   */
  private countNodes(
    node: any,
    counts: { heading: number; image: number; codeBlock: number }
  ): void {
    if (!node || typeof node !== 'object') return;

    if (node.type === 'heading') counts.heading++;
    else if (node.type === 'image') counts.image++;
    else if (node.type === 'codeBlock') counts.codeBlock++;

    if (Array.isArray(node.content)) {
      for (const child of node.content) {
        this.countNodes(child, counts);
      }
    }
  }

  private sanitizeNode(node: any): any {
    if (!node || typeof node !== 'object') return node;

    const sanitized = { ...node };

    if (sanitized.type === 'text' && typeof sanitized.text === 'string') {
      // Basic escaping of < and > to prevent raw HTML execution if the frontend renders unsafely
      sanitized.text = sanitized.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // Neutralize dangerous URL schemes on node attrs (e.g. an image `src` of
    // `javascript:...`) so they can't execute if rendered.
    if (sanitized.attrs && typeof sanitized.attrs === 'object') {
      sanitized.attrs = this.sanitizeUrlAttrs(sanitized.attrs);
    }

    // Sanitize marks (e.g. drop a link mark whose href is a `javascript:` URL).
    if (Array.isArray(sanitized.marks)) {
      sanitized.marks = sanitized.marks
        .map((mark: any) => this.sanitizeMark(mark))
        .filter((mark: any) => mark !== null);
    }

    if (Array.isArray(sanitized.content)) {
      sanitized.content = sanitized.content.map((child: any) => this.sanitizeNode(child));
    }

    return sanitized;
  }

  private sanitizeMark(mark: any): any {
    if (!mark || typeof mark !== 'object') return mark;
    // Drop a link mark entirely when its href uses a dangerous scheme.
    if (
      mark.type === 'link' &&
      typeof mark.attrs?.href === 'string' &&
      this.DANGEROUS_URL.test(mark.attrs.href)
    ) {
      return null;
    }
    if (mark.attrs && typeof mark.attrs === 'object') {
      return { ...mark, attrs: this.sanitizeUrlAttrs(mark.attrs) };
    }
    return mark;
  }

  private sanitizeUrlAttrs(attrs: Record<string, any>): Record<string, any> {
    const out = { ...attrs };
    for (const key of ['href', 'src']) {
      if (typeof out[key] === 'string' && this.DANGEROUS_URL.test(out[key])) {
        out[key] = null;
      }
    }
    return out;
  }
}

export const editorParser = new TiptapParser();
