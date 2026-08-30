'use strict';

/**
 * Policy for the extra arguments handed to `claude`.
 *
 * Arguments carry a trust level: `trusted` for what a local operator typed,
 * `untrusted` for anything read out of a repository file. A person may disable
 * their own permission model; a cloned `.orchestra.json` may not decide that
 * for them.
 */

/** cmd.exe syntax. A legitimate claude flag never needs any of it. */
const CMD_METACHARACTERS = /[&|<>^%\r\n\0]/;

const PERMISSION_BYPASS = [
  /^--dangerously-skip-permissions$/i,
  /^--permission-mode(=|$)/i,
  /^--permission-prompt-tool(=|$)/i,
  /^--permission-prompts(=|$)/i,
];

const BYPASS_VALUES = /^(bypasspermissions|acceptedits|none)$/i;

/** True when this flag and its value actually remove the prompt; `plan` restricts. */
function isBypass(arg, argv, i) {
  if (/^--dangerously-skip-permissions$/i.test(arg)) return true;
  const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : argv[i + 1];
  return value !== undefined && BYPASS_VALUES.test(String(value));
}

/**
 * @param {string} args raw argument string, as typed or as read from a recipe
 * @param {string[]} argv the same string already split
 * @param {'trusted'|'untrusted'} trust
 * @returns {{ok: true, warnings: string[]} | {ok: false, reason: string}}
 */
function checkArgs(args, argv, trust) {
  if (!args) return { ok: true, warnings: [] };

  if (CMD_METACHARACTERS.test(args)) {
    return {
      ok: false,
      reason: 'Arguments contain a shell metacharacter (& | < > ^ % or a newline). '
        + 'Claude flags never need these, and on Windows they would run as a separate command.',
    };
  }

  const warnings = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!PERMISSION_BYPASS.some(re => re.test(arg))) continue;
    if (!isBypass(arg, argv, i)) continue;

    if (trust === 'untrusted') {
      return {
        ok: false,
        reason: `"${arg}" disables Claude Code's permission model. A recipe committed in a repository `
          + 'cannot make that choice for you. Remove it, or start the agent yourself with that flag.',
      };
    }
    warnings.push(`"${arg}" disables the permission model for this session; approvals will not fire.`);
  }

  return { ok: true, warnings };
}

/**
 * Quotes one token for a cmd.exe command line: always quoted so spaces survive,
 * inner quotes doubled, which is cmd's own escape. Backslash escaping is the
 * MSVC convention and cmd does not understand it.
 */
function quoteForCmd(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

module.exports = { checkArgs, quoteForCmd, CMD_METACHARACTERS, PERMISSION_BYPASS };
