// 外から来る JSON（作業フォルダのファイル、API の応答、プレーヤーの返り値）を型を確かめながら読む。
import { readFileSync } from 'node:fs';

export type Json = Record<string, unknown>;

export const isRecord = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

// Reads obj[key] without trusting obj's shape.
export const field = (obj: unknown, key: string): unknown => (isRecord(obj) ? obj[key] : undefined);

export const readJson = (file: string): unknown => JSON.parse(readFileSync(file, 'utf8'));

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
