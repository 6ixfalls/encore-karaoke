// Same Kuroshiro/Kuromoji analyzer used by upstream's native romanization bridge.
import { createRequire } from "node:module";
import { Fault } from "../shared/contracts.js";
const require = createRequire(import.meta.url);
interface Converter {
  init(analyzer: object): Promise<void>;
  convert(text: string, options: { to: string; mode: string; romajiSystem: string }): Promise<string>;
}
export class Romanization {
  private ready?: Promise<Converter>;
  private cache = new Map<string, string>();
  private active = 0;
  private initialize(): Promise<Converter> {
    if (!this.ready) this.ready = (async () => {
      const Kuroshiro = (require("kuroshiro") as { default: new () => Converter }).default;
      const Analyzer = require("kuroshiro-analyzer-kuromoji") as new () => object;
      const converter = new Kuroshiro(); await converter.init(new Analyzer()); return converter;
    })().catch(error => { this.ready = undefined; throw error; });
    return this.ready;
  }
  async convert(text: string): Promise<string> {
    const cached = this.cache.get(text); if (cached !== undefined) return cached;
    if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) return "";
    if (this.active >= 4) throw new Fault("romanization_busy", 429);
    this.active++;
    try {
      const converter = await this.initialize();
      const result = await converter.convert(text, { to: "romaji", mode: "spaced", romajiSystem: "hepburn" });
      if (this.cache.size >= 500) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(text, result); return result;
    } finally { this.active--; }
  }
}
