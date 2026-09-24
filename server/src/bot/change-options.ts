import type { TrainInfo } from '../types.js';
import type { TravelScheme } from './tickets.js';

export interface ChangeLeg {
  trainCode: string;
  fromStation: string;
  toStation: string;
  departTime: string;
  arriveTime: string;
  date: string;
  seatTypes: string[];
}

export interface ChangeOption {
  kind: 'direct' | 'transfer' | 'same-train' | 'supplement';
  label: string;
  fromStation: string;
  toStation: string;
  departTime: string;
  arriveTime: string;
  duration: string;
  trains: string[];
  reason: string;
  legs: ChangeLeg[];
}

function minutes(clock: string): number {
  const match = /^(\d{1,2}):(\d{2})/.exec(clock);
  if (!match) return 24 * 60;
  return Number(match[1]) * 60 + Number(match[2]);
}

function durationMinutes(text: string): number {
  const match = /(\d+):(\d{2})/.exec(text);
  if (!match) return 24 * 60;
  return Number(match[1]) * 60 + Number(match[2]);
}

function hasSeat(seats: Record<string, string>): boolean {
  return Object.entries(seats).some(([name, count]) => name !== '商务座' && name !== '无座' && count !== '' && count !== '无' && count !== '--' && count !== '0');
}

function seatCodes(seats: Record<string, string>): string[] {
  const map: Record<string, string> = { 特等座: 'TZ', 一等座: 'ZY', 二等座: 'ZE', 高级软卧: 'GR', 软卧: 'RW', 硬卧: 'YW', 软座: 'RZ', 硬座: 'YZ' };
  return Object.entries(seats).filter(([name, count]) => map[name] && count !== '' && count !== '无' && count !== '--' && count !== '0').map(([name]) => map[name]);
}

/** 靠近原出发时刻、总历时更短的排前面。没有普通席别余票的不进列表。 */
export function rankChangeOptions(input: {
  mode: 'to-direct' | 'to-transfer';
  date: string;
  departTime: string;
  currentTrains: string[];
  trains: TrainInfo[];
  schemes: TravelScheme[];
}): ChangeOption[] {
  const origin = minutes(input.departTime);
  const current = new Set(input.currentTrains.map((code) => code.replace(/\s/g, '').toUpperCase()));
  const options: Array<ChangeOption & { score: number }> = [];
  if (input.mode === 'to-direct') {
    for (const train of input.trains) {
      const code = train.trainCode.replace(/\s/g, '').toUpperCase();
      if (current.has(code) || !hasSeat(train.seats)) continue;
      const depart = minutes(train.departTime);
      const gap = Math.abs(depart - origin);
      options.push({
        kind: 'direct',
        label: '直达',
        fromStation: train.fromStation,
        toStation: train.toStation,
        departTime: train.departTime,
        arriveTime: train.arriveTime,
        duration: train.duration,
        trains: [train.trainCode],
        reason: gap <= 180 ? '出发时刻接近，且全程不用换乘' : '同时段直达，可替代两段衔接',
        legs: [{
          trainCode: train.trainCode,
          fromStation: train.fromStation,
          toStation: train.toStation,
          departTime: train.departTime,
          arriveTime: train.arriveTime,
          date: input.date,
          seatTypes: seatCodes(train.seats),
        }],
        score: gap + durationMinutes(train.duration),
      });
    }
  } else {
    for (const scheme of input.schemes) {
      if (!scheme.legs.length || scheme.legs.some((leg) => !hasSeat(leg.seats))) continue;
      const codes = scheme.legs.map((leg) => leg.trainCode.replace(/\s/g, '').toUpperCase());
      if (codes.length === current.size && codes.every((code) => current.has(code))) continue;
      const depart = minutes(scheme.departTime || scheme.legs[0].departTime);
      const wait = durationMinutes(scheme.waitTime);
      const gap = Math.abs(depart - origin);
      options.push({
        kind: scheme.kind,
        label: scheme.label,
        fromStation: scheme.fromStation,
        toStation: scheme.toStation,
        departTime: scheme.departTime || scheme.legs[0].departTime,
        arriveTime: scheme.arriveTime || scheme.legs[scheme.legs.length - 1].arriveTime,
        duration: scheme.duration,
        trains: scheme.legs.map((leg) => leg.trainCode),
        reason: wait <= 90 ? `换乘等待 ${scheme.waitTime || '较短'}，两段都有余票` : '车站可衔接，等待偏长',
        legs: scheme.legs.map((leg) => ({
          trainCode: leg.trainCode,
          fromStation: leg.fromStation,
          toStation: leg.toStation,
          departTime: leg.departTime,
          arriveTime: leg.arriveTime,
          date: leg.date || input.date,
          seatTypes: leg.seatTypes,
        })),
        score: gap + durationMinutes(scheme.duration) + wait,
      });
    }
  }
  return options.sort((a, b) => a.score - b.score).slice(0, 8).map(({ score: _score, ...option }) => option);
}
