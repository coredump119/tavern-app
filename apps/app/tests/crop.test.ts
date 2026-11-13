import { describe, expect, it } from 'vitest';
import { cropFraction, initialCrop, maxCropSize, moveCrop, scaleCrop } from '../src/lib/crop';

describe('avatar crop box (DEV_NOTES §9.37)', () => {
  it('starts as the largest centred 2:3 box', () => {
    // wide picture: full height, centred horizontally
    expect(initialCrop(900, 600)).toEqual({ x: 250, y: 0, width: 400, height: 600 });
    // tall picture: full width, centred vertically
    expect(initialCrop(200, 900)).toEqual({ x: 0, y: 300, width: 200, height: 300 });
    // already 2:3
    expect(initialCrop(512, 768)).toEqual({ x: 0, y: 0, width: 512, height: 768 });
    expect(maxCropSize(300, 300, 1)).toEqual({ width: 300, height: 300 });
  });

  it('moves inside the image only', () => {
    const start = initialCrop(900, 600);
    expect(moveCrop(start, 900, 600, 100, 50)).toMatchObject({ x: 350, y: 0 });
    expect(moveCrop(start, 900, 600, -999, 0).x).toBe(0);
    expect(moveCrop(start, 900, 600, 999, 0).x).toBe(500);
  });

  it('resizes around its centre and stays inside', () => {
    const start = initialCrop(900, 600);
    const half = scaleCrop(start, 900, 600, 0.5);
    expect(half).toEqual({ x: 350, y: 150, width: 200, height: 300 });
    expect(cropFraction(half, 900, 600)).toBeCloseTo(0.5);
    // a small box pushed into the corner grows back without leaving the image
    const corner = moveCrop(half, 900, 600, 999, 999);
    expect(corner).toMatchObject({ x: 700, y: 300 });
    expect(scaleCrop(corner, 900, 600, 1)).toEqual({ x: 500, y: 0, width: 400, height: 600 });
    // the slider cannot go below the minimum
    expect(scaleCrop(start, 900, 600, 0).width).toBeCloseTo(80);
  });
});
