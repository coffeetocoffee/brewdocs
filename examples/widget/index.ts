export const SIZE_SM = 250;
export const SIZE_LG = 500;

export interface WidgetOptions {
  size: number;
  label?: string;
}

export class Widget {
  size: number;
  label?: string;

  constructor(opts: WidgetOptions) {
    this.size = opts.size;
    this.label = opts.label;
  }

  render(): string {
    return `[${this.label ?? "widget"}:${this.size}]`;
  }
}
