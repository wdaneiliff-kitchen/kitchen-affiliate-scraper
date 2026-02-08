/**
 * 2Captcha integration using @2captcha/captcha-solver for reCAPTCHA v2.
 * @see https://www.npmjs.com/package/@2captcha/captcha-solver
 *
 * @module uppromote/twocaptcha
 */

import { Solver } from '@2captcha/captcha-solver';

/** Polling interval (ms); package default 5000, docs recommend not less than 5s */
const POLLING_INTERVAL_MS = 5000;

/**
 * Solves reCAPTCHA v2 via 2Captcha using @2captcha/captcha-solver.
 *
 * @param {string} clientKey - 2Captcha API key
 * @param {Object} options - Task options
 * @param {string} options.websiteURL - Full URL of the page where the captcha is loaded
 * @param {string} options.websiteKey - reCAPTCHA sitekey (data-sitekey)
 * @returns {Promise<string|null>} - gRecaptchaResponse token or null on failure
 */
export async function solveRecaptchaV2(clientKey, options) {
  const { websiteURL, websiteKey } = options;

  try {
    const solver = new Solver(clientKey, POLLING_INTERVAL_MS);
    // solver.recaptcha() returns { data: "token...", id: "taskId" }
    const result = await solver.recaptcha({
      pageurl: websiteURL,
      googlekey: websiteKey,
    });
    return result?.data ?? null;
  } catch (error) {
    console.warn(`   2Captcha error: ${error.message}`);
    return null;
  }
}
