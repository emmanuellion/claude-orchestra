'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');

const SANDBOX_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-cli-'));
process.env.HOME = SANDBOX_HOME;
process.env.USERPROFILE = SANDBOX_HOME;
process.env.ORCHESTRA_TOKEN = 'b'.repeat(64);

const { test } = require('node:test');
const assert = require('node:assert/strict');

// bin/cli.js only starts a server under require.main, and it requires the
// server lazily, so importing it here spawns nothing.
const cli = require('../bin/cli');

test('no arguments means the defaults', () => {
  const { options, errors } = cli.parseArgs([]);
  assert.deepEqual(errors, []);
  assert.equal(options.port, null);
  assert.equal(options.host, null);
  assert.equal(options.cwd, null);
  assert.equal(options.open, true);
  assert.equal(options.help, false);
});

test('the port is parsed in both spellings', () => {
  assert.equal(cli.parseArgs(['--port', '3100']).options.port, 3100);
  assert.equal(cli.parseArgs(['--port=3100']).options.port, 3100);
  assert.equal(cli.parseArgs(['-p', '3100']).options.port, 3100);
});

test('a non numeric or out of range port is an error, not a crash', () => {
  assert.equal(cli.parseArgs(['--port', 'abc']).errors.length, 1);
  assert.equal(cli.parseArgs(['--port', '0']).errors.length, 1);
  assert.equal(cli.parseArgs(['--port', '70000']).errors.length, 1);
  assert.equal(cli.parseArgs(['--port']).errors.length, 1);
  assert.equal(cli.parseArgs(['--port', '--no-open']).errors.length, 1);
});

test('--no-open wins over the default and --open restores it', () => {
  assert.equal(cli.parseArgs(['--no-open']).options.open, false);
  assert.equal(cli.parseArgs(['--no-open', '--open']).options.open, true);
});

test('a bare directory is taken as the working directory', () => {
  const { options, errors } = cli.parseArgs(['../api']);
  assert.deepEqual(errors, []);
  assert.ok(path.isAbsolute(options.cwd), 'cwd is resolved to an absolute path');
  assert.equal(path.basename(options.cwd), 'api');
});

test('--cwd is resolved to an absolute path', () => {
  const { options } = cli.parseArgs(['--cwd', 'sub/dir']);
  assert.ok(path.isAbsolute(options.cwd));
  assert.equal(path.basename(options.cwd), 'dir');
});

test('two directories, or a directory plus --cwd, is an error', () => {
  assert.equal(cli.parseArgs(['a', 'b']).errors.length, 1);
  assert.equal(cli.parseArgs(['a', '--cwd', 'b']).errors.length, 1);
});

test('an unknown option is reported by name', () => {
  const { errors } = cli.parseArgs(['--turbo']);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /--turbo/);
});

test('a value given to a boolean flag is refused', () => {
  assert.equal(cli.parseArgs(['--no-open=1']).errors.length, 1);
});

test('a short token is refused so a typo cannot weaken the server', () => {
  assert.equal(cli.parseArgs(['--token', 'abc']).errors.length, 1);
  assert.equal(cli.parseArgs(['--token', 'a'.repeat(32)]).errors.length, 0);
});

test('flags combine without interfering', () => {
  const { options, errors } = cli.parseArgs([
    '--port', '3100', '--host', '0.0.0.0', '--no-open',
    '--workspace', 'review', '--cwd', '.',
  ]);
  assert.deepEqual(errors, []);
  assert.equal(options.port, 3100);
  assert.equal(options.host, '0.0.0.0');
  assert.equal(options.open, false);
  assert.equal(options.workspace, 'review');
  assert.ok(path.isAbsolute(options.cwd));
});

test('help and version are recognised anywhere in the line', () => {
  assert.equal(cli.parseArgs(['--help']).options.help, true);
  assert.equal(cli.parseArgs(['-h']).options.help, true);
  assert.equal(cli.parseArgs(['--port', '3100', '--version']).options.version, true);
  assert.equal(cli.parseArgs(['-v']).options.version, true);
});

test('a wildcard host is rewritten to something a browser can open', () => {
  assert.equal(cli.browsableHost('0.0.0.0'), '127.0.0.1');
  assert.equal(cli.browsableHost('::'), '127.0.0.1');
  assert.equal(cli.browsableHost('127.0.0.1'), '127.0.0.1');
  assert.equal(cli.browsableHost('192.168.1.20'), '192.168.1.20');
});

test('an IPv6 host is bracketed in a URL', () => {
  assert.equal(cli.formatHost('::1'), '[::1]');
  assert.equal(cli.formatHost('[::1]'), '[::1]');
  assert.equal(cli.formatHost('127.0.0.1'), '127.0.0.1');
});

test('the token is appended as a query parameter and escaped', () => {
  assert.equal(
    cli.urlWithToken('http://127.0.0.1:3000', 'abc'),
    'http://127.0.0.1:3000?token=abc',
  );
  assert.equal(
    cli.urlWithToken('http://127.0.0.1:3000/?x=1', 'a b'),
    'http://127.0.0.1:3000/?x=1&token=a%20b',
  );
  assert.equal(cli.urlWithToken('http://127.0.0.1:3000', ''), 'http://127.0.0.1:3000');
});

test('openBrowser refuses anything that is not an http url', async () => {
  const err = await cli.openBrowser('file:///C:/Windows/System32/calc.exe');
  assert.ok(err instanceof Error, 'a non http target must be refused, not launched');
  const err2 = await cli.openBrowser('javascript:alert(1)');
  assert.ok(err2 instanceof Error);
});

test('the help text mentions every option', () => {
  const help = cli.helpText();
  for (const flag of ['--port', '--host', '--cwd', '--workspace', '--token', '--no-open', '--version', '--help']) {
    assert.ok(help.includes(flag), `help should document ${flag}`);
  }
});
