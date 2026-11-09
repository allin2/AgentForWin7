'use strict';

const fs = require('fs');
const path = require('path');
function failure(code, message) { return Object.assign(new Error(message), { code }); }
const key = value => path.resolve(value).toLowerCase();
const identityKey = value => process.platform === 'win32' ? key(value) : path.resolve(value);
const device = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i;

// normalize is the State title normalizer, injected to keep this generator pure.
function defaultWorkdirName(prompt, date, normalize) {
  let name = Array.from(normalize(prompt, 40).replace(/[<>:"/\\|?*]/g, '').replace(/[. ]+$/, '')).slice(0, 12).join('').replace(/[. ]+$/, '');
  if (!name || device.test(name)) name = '新任务';
  return `${name}_${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`;
}
function validateWorkdirName(name) {
  if (typeof name !== 'string' || !name || Array.from(name).length > 20 || /[<>:"/\\|?*\u0000-\u001f\u007f-\u009f]/.test(name)
    || /[. ]$/.test(name) || name === '.' || name === '..' || device.test(name)) {
    throw failure('A9_WORKDIR_NAME_INVALID', '目录名必须为 1～20 字，且不能包含 Windows 非法字符或设备名。');
  }
  return name;
}
function pathOccupied(root, name, reservations) {
  const target = key(path.join(root, name));
  if (reservations.some(value => key(value) === target)) return true;
  try { return fs.readdirSync(root).some(value => value.toLowerCase() === name.toLowerCase()); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function reserveWorkdir(root, prompt, date, normalize, reservations) {
  const base = defaultWorkdirName(prompt, date, normalize);
  for (let index = 1; index <= 99; index++) {
    const name = index === 1 ? base : `${base}_${String(index).padStart(2, '0')}`;
    if (!pathOccupied(root, name, reservations)) return path.join(root, name);
  }
  throw failure('A9_WORKDIR_NAME_EXHAUSTED', '默认目录名已用尽，请改为关联已有目录。');
}
function verifyWorkdir(root, workspace, create = false) {
  // Both the parent and child identity are checked on every use. lstat catches
  // dangling links as well: they are never treated as an absent reservation.
  let realRoot;
  try { realRoot = fs.realpathSync(root); }
  catch (_error) { throw failure('A9_WORKDIR_IDENTITY_CHANGED', '默认根目录不可读取，身份无法确认。'); }
  if (identityKey(realRoot) !== identityKey(root) || path.dirname(workspace) !== root) {
    throw failure('A9_WORKDIR_IDENTITY_CHANGED', '默认根目录身份已变化。');
  }
  let stat;
  try { stat = fs.lstatSync(workspace); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  let made = false;
  if (!stat && create) {
    try { fs.mkdirSync(workspace); made = true; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    stat = fs.lstatSync(workspace);
  }
  if (stat) {
    let valid = false;
    try { valid = fs.statSync(workspace).isDirectory() && identityKey(fs.realpathSync(workspace)) === identityKey(workspace); }
    catch (_error) { /* An unreadable/dangling link is an unconfirmed identity. */ }
    if (!valid) throw failure('A9_WORKDIR_IDENTITY_CHANGED', '工作目录身份已变化，请改为关联已有目录。');
  }
  return { created: Boolean(stat), made };
}
module.exports = { defaultWorkdirName, validateWorkdirName, pathOccupied, reserveWorkdir, verifyWorkdir };
