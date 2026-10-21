import Aromanize from "./vendor/aromanize.js";
export interface RomanizationService {
  request(path: string, options: { method: string; body: object }): Promise<{ text: string }>;
}
export class Romanizer {
  constructor(privateService: RomanizationService, roomId: () => string | undefined) {
    this.service = privateService; this.roomId = roomId;
  }
  private service: RomanizationService;
  private roomId: () => string | undefined;
  private tail: Promise<void> = Promise.resolve();
  async romanize(text: string): Promise<string | null> {
    if (/[\uac00-\ud7af]/.test(text) && !/[\u3040-\u30ff\u3400-\u9fff]/.test(text))
      return Aromanize.romanize(text);
    const room = this.roomId();
    if (!room || !/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) return null;
    const work = this.tail.then(() => this.service.request(`/api/rooms/${room}/romanize`, { method: "POST", body: { text } }));
    this.tail = work.then(() => {}, () => {});
    const result = await work;
    return result.text;
  }
}
