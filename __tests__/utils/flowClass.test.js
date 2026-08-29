import { readFileSync } from 'fs';
import { classifyFlow } from '@/scripts/lib/flow-class.mjs';
import {
  SODA_NEIGHBOR_SLUGS,
  stationBySlugOrName,
} from '@/scripts/lib/stations.mjs';
import { zonedTime } from '@/scripts/lib/zone.mjs';

function record(slug, transform = () => ({}), cycleType = '5min') {
  const date = '2026-08-28';
  const start = zonedTime(2026, 7, 28, 0, 0, 0).getTime() / 1000;
  const points = [];
  for (let minute = 0; minute < 10 * 60; minute += 5) {
    points.push({
      ts: start + minute * 60,
      speed: 2,
      gust: 5,
      dir: 90,
      rh: 50,
      temp: 60,
      ...transform(minute),
    });
  }
  return {
    date,
    station: slug === 'dp-soda-lakes' ? 'DP Soda Lakes' : slug,
    status: 'ok',
    cycle_type: cycleType,
    points,
  };
}

function neighbors(transform = () => ({})) {
  return SODA_NEIGHBOR_SLUGS.map((slug) => ({
    slug,
    record: record(slug, transform),
  }));
}

describe('flow-class-v1', () => {
  it('classifies continuous local W/NW flow as katabatic', () => {
    const target = record('dp-soda-lakes', () => ({
      speed: 13,
      gust: 20,
      dir: 290,
    }));
    expect(classifyFlow(target, neighbors()).flowClass).toBe('katabatic');
  });

  it('classifies a collapse and later local W/NW pulse as transition-hybrid', () => {
    const target = record('dp-soda-lakes', (minute) => {
      if (minute >= 4 * 60 + 30 && minute < 5 * 60) {
        return { speed: 2, gust: 5, dir: 120 };
      }
      return { speed: 13, gust: 21, dir: 290 };
    });
    expect(classifyFlow(target, neighbors()).flowClass).toBe('transition-hybrid');
  });

  it('classifies concurrent organized wind at both neighbors as synoptic', () => {
    const windy = () => ({ speed: 13, gust: 20, dir: 290 });
    expect(classifyFlow(record('dp-soda-lakes', windy), neighbors(windy)).flowClass).toBe('synoptic');
  });

  it('classifies adequate calm non-W/NW data as absent', () => {
    expect(classifyFlow(record('dp-soda-lakes'), neighbors()).flowClass).toBe('absent');
  });

  it('returns stamped unknown for missing or coarse required evidence', () => {
    const target = record('dp-soda-lakes', () => ({ speed: 13, dir: 290 }));
    const missing = classifyFlow(target, neighbors().slice(0, 1));
    expect(missing).toMatchObject({ flowClassVersion: 'flow-class-v1', flowClass: 'unknown' });

    const coarse = neighbors();
    coarse[1].record = record(coarse[1].slug, () => ({}), '240min');
    expect(classifyFlow(target, coarse).flowClass).toBe('unknown');
  });

  it('resolves exact station names without heuristic slug mangling', () => {
    expect(stationBySlugOrName('DP Soda Lakes').slug).toBe('dp-soda-lakes');
    expect(stationBySlugOrName('Lookout Mtn - RMHPA').slug).toBe('lookout-mtn');
    expect(() => stationBySlugOrName('lookout-mtn---rmhpa')).toThrow('Unknown station');
  });

  it('stays outside every prediction and same-morning rule module', () => {
    const files = [
      'scripts/lib/night-before-call.mjs',
      'scripts/lib/call-rule.mjs',
      'scripts/lib/call-rule-v2.mjs',
      'scripts/lib/call-rule-v3.mjs',
      'scripts/lib/call-rule-v4.mjs',
      'scripts/lib/call-rule-v5.mjs',
    ];
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/from ['"].*flow-class/);
    }
  });
});
