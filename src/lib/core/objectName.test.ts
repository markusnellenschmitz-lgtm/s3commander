import { describe, expect, it } from 'vitest';
import { baseName, nameError, numberedName, parentOfKey } from './objectName';

describe('nameError', () => {
  it('akzeptiert normale Namen', () => {
    expect(nameError('neu', 'a/', true)).toBeNull();
    expect(nameError('bericht 2026.pdf', '', false)).toBeNull();
    expect(nameError('x'.repeat(1023), '', true)).toBeNull();
  });

  it.each([
    ['  ', 'Bitte einen Namen eingeben'],
    ['a/b', 'Der Name darf keinen Schrägstrich enthalten'],
    ['..', '„.“ und „..“ sind als Name nicht erlaubt'],
    ['.', '„.“ und „..“ sind als Name nicht erlaubt'],
    ['tab\tname', 'Der Name darf keine Steuerzeichen enthalten'],
    ['x'.repeat(1024), 'Der vollständige Key darf höchstens 1.024 Bytes lang sein'],
  ])('lehnt %j ab', (name, message) => {
    expect(nameError(name, '', true)).toBe(message);
  });

  it('zählt Bytes, nicht Zeichen', () => {
    expect(nameError('ü'.repeat(600), '', false)).toBe('Der vollständige Key darf höchstens 1.024 Bytes lang sein');
  });
});

describe('Key-Teile', () => {
  it('findet Elternordner und Namen', () => {
    expect(parentOfKey('a/b/c.txt')).toBe('a/b/');
    expect(parentOfKey('a/b/')).toBe('a/');
    expect(parentOfKey('c.txt')).toBe('');
    expect(baseName('a/b/')).toBe('b');
    expect(baseName('a/c.txt')).toBe('c.txt');
  });

  it('nummeriert Namen bei Konflikten', () => {
    expect(numberedName('bild.jpg', 2)).toBe('bild (2).jpg');
    expect(numberedName('liesmich', 3)).toBe('liesmich (3)');
    expect(numberedName('.env', 2)).toBe('.env (2)');
  });
});
