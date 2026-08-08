import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { contentTypeFor } from '../../src/static/content-types.ts';

describe('contentTypeFor', () => {
  it('should return correct type for known extensions', () => {
    expect(contentTypeFor('test.js')).toBe('text/javascript');
    expect(contentTypeFor('test.css')).toBe('text/css');
    expect(contentTypeFor('test.html')).toBe('text/html');
    expect(contentTypeFor('test.json')).toBe('application/json');
    expect(contentTypeFor('test.png')).toBe('image/png');
    expect(contentTypeFor('test.jpg')).toBe('image/jpeg');
    expect(contentTypeFor('test.gif')).toBe('image/gif');
    expect(contentTypeFor('test.webp')).toBe('image/webp');
    expect(contentTypeFor('test.svg')).toBe('image/svg+xml');
    expect(contentTypeFor('test.txt')).toBe('text/plain');
    expect(contentTypeFor('test.xml')).toBe('application/xml');
    expect(contentTypeFor('test.map')).toBe('application/json');
    expect(contentTypeFor('test.wasm')).toBe('application/wasm');
    expect(contentTypeFor('test.mp4')).toBe('video/mp4');
    expect(contentTypeFor('test.webm')).toBe('video/webm');
    expect(contentTypeFor('test.eot')).toBe('application/vnd.ms-fontobject');
    expect(contentTypeFor('test.md')).toBe('text/markdown');
    expect(contentTypeFor('test.pdf')).toBe('application/pdf');
    expect(contentTypeFor('test.zip')).toBe('application/zip');
    expect(contentTypeFor('test.gz')).toBe('application/gzip');
    expect(contentTypeFor('test.br')).toBe('application/brotli');
    expect(contentTypeFor('test.woff2')).toBe('font/woff2');
    expect(contentTypeFor('test.woff')).toBe('font/woff');
    expect(contentTypeFor('test.ttf')).toBe('font/ttf');
    expect(contentTypeFor('test.otf')).toBe('font/otf');
    expect(contentTypeFor('test.bmp')).toBe('image/bmp');
    expect(contentTypeFor('test.csv')).toBe('text/csv');
    expect(contentTypeFor('test.ics')).toBe('text/calendar');
  });

  it('should be case-insensitive', () => {
    expect(contentTypeFor('TEST.JS')).toBe('text/javascript');
    expect(contentTypeFor('Test.Css')).toBe('text/css');
  });

  it('should return octet-stream for unknown extensions', () => {
    expect(contentTypeFor('test.unknown')).toBe('application/octet-stream');
    expect(contentTypeFor('test')).toBe('application/octet-stream');
  });

  it('should handle paths with directories', () => {
    expect(contentTypeFor('/path/to/file.js')).toBe('text/javascript');
    expect(contentTypeFor('/path/to/file.unknown')).toBe('application/octet-stream');
  });
});
