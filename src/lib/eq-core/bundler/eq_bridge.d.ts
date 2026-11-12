/* tslint:disable */
/* eslint-disable */

/**
 * JSON bands `[{type,freq,gain,q}]` and JSON frequency list. Returns a JSON array of dB.
 */
export function curve_db(bands_json: string, freqs_json: string, sample_rate: number): string;

/**
 * Empty string when the library accepts the bands. Otherwise the library's error.
 */
export function design_error(channel: string, bands_json: string, sample_rate: number): string;
