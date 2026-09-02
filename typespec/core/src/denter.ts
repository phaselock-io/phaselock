/** A helper class for accumulating generated source text with tracked indentation. */
export class Denter {
  private indents: string[] = [];
  private idnt: string;
  private chunks: string[] = [''];

  constructor(indent = '') {
    this.idnt = indent;
  }

  indent(idnt: string): void {
    this.indents.push(idnt);
    this.idnt = this.indents.join('');
  }

  dedent(): void {
    this.indents.pop();
    this.idnt = this.indents.join('');
  }

  print(s: string): void {
    const lines = s.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idnt = line && this.chunks[this.chunks.length - 1].endsWith('\n') ? this.idnt : '';
      const end = i + 1 < lines.length ? '\n' : '';
      const chunk = idnt + line + end;
      if (chunk) this.chunks.push(chunk);
    }
  }

  getvalue(): string {
    return this.chunks.join('');
  }

  child(): Denter {
    return new Denter(this.idnt);
  }
}
