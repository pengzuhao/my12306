/**
 * 车站名 ↔ 电报码 解析。
 * 数据源：12306 官方 station_name.js（含全部车站及拼音/缩写），本地缓存。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { URLS } from './constants.js';
import type { Station } from '../types.js';

const CACHE_FILE = path.join(DATA_DIR, 'stations.json');
let stations: Map<string, Station> | null = null;

function parseStationJs(text: string): Station[] {
  // 格式：var station_names = '@bjb|北京北|VAP|beijingbei|bjb|0@bjn|北京南|VNP|beijingnan|bjn|1@...';
  const list: Station[] = [];
  const raw = text.replace(/^var\s+station_names\s*=\s*'?/, '').replace(/';?\s*$/, '');
  for (const item of raw.split('@')) {
    if (!item) continue;
    const parts = item.split('|');
    if (parts.length < 5) continue;
    list.push({ abbr: parts[0], name: parts[1], code: parts[2], pinyin: parts[3] });
  }
  return list;
}

async function loadStations(): Promise<Map<string, Station>> {
  if (stations) return stations;
  // 先用本地缓存
  if (fs.existsSync(CACHE_FILE)) {
    try {
      const arr = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as Station[];
      stations = new Map(arr.map((s) => [s.name, s]));
      return stations;
    } catch {
      // 缓存损坏则重新拉取
    }
  }
  // 从 12306 拉取
  const res = await fetch(URLS.STATION_NAME_JS, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`拉取车站列表失败：${res.status}`);
  const text = await res.text();
  const arr = parseStationJs(text);
  stations = new Map(arr.map((s) => [s.name, s]));
  fs.writeFileSync(CACHE_FILE, JSON.stringify(arr, null, 2));
  return stations;
}

/** 车站名 → 电报码（如 南京 → NJH）。支持"南京""南京南"等精确站名。 */
export async function stationCode(name: string): Promise<string | null> {
  const map = await loadStations();
  const s = map.get(name);
  if (s) return s.code;
  // 模糊：去掉"站"字后重试
  const s2 = map.get(name.replace(/站$/, ''));
  if (s2) return s2.code;
  return null;
}

/** 获取全部车站（管理台城市选择器用） */
export async function listStations(): Promise<Station[]> {
  const map = await loadStations();
  return [...map.values()];
}

/** 拼音/缩写前缀搜索（前端下拉提示） */
export async function searchStations(keyword: string, limit = 10): Promise<Station[]> {
  const map = await loadStations();
  const kw = keyword.trim().toLowerCase();
  if (!kw) return [];
  const out: Station[] = [];
  for (const s of map.values()) {
    if (s.name.includes(keyword) || s.pinyin.startsWith(kw) || s.abbr.startsWith(kw)) {
      out.push(s);
      if (out.length >= limit) break;
    }
  }
  return out;
}
