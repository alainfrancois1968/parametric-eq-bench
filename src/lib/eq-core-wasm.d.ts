declare module "@/lib/eq-core/bundler/eq_bridge.js" {
  export function curve_db(bands: string, freqs: string, sampleRate: number): string;
  export function design_error(channel: string, bands: string, sampleRate: number): string;
}
