'use strict';

const { errors } = require('zapier-platform-core');

/**
 * A mistake in what the user filled in, found before anything is sent. Thrown as Zapier's
 * AppError (the same class as z.errors.Error), whose message Zapier shows to the user. The
 * code mirrors the API's own "invalid_request", so both kinds of mistake read alike.
 *
 * @param {string} message what to change, in the words of the Zap editor's fields
 * @returns {Error}
 */
function inputError(message) {
  return new errors.Error(message, 'invalid_request', 400);
}

module.exports = { inputError };
