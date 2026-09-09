// Entry point for the esbuild bundle (see package.json's "build" script).
// index.html still expects every one of these as a bare global — its
// inline <script> block was written before any of this existed and calls
// genId()/toIsoDate()/etc. directly, as does the existing Playwright
// suite (tests/helpers.js's seedSession() and several specs read/call
// these as window-level globals too). Native ES modules would NOT expose
// these as globals on their own — see the architecture roadmap's own
// note on why this app uses a bundled IIFE instead of <script type="module">.
// Every later extraction phase adds its own import here and assigns it
// the same way; this file is the one place that has to know the whole
// list.
import { genId, safeJsonParse } from './utils/id';
import { getDaysDiff, toIsoDate, addMonths, getBusinessDaysDiff, addBusinessDays, formatTimeLabel, timeToMinutes } from './utils/date';
import { darkenColor, softenColor, SOFTEN_AMOUNT } from './utils/color';
import { findJob, findTask, getJobPhases, getPhaseSubUnits, getPhaseCard, getJobCards, getPrimaryPhaseCard } from './core/models';

declare global {
  interface Window {
    genId: typeof genId;
    safeJsonParse: typeof safeJsonParse;
    getDaysDiff: typeof getDaysDiff;
    toIsoDate: typeof toIsoDate;
    addMonths: typeof addMonths;
    getBusinessDaysDiff: typeof getBusinessDaysDiff;
    addBusinessDays: typeof addBusinessDays;
    formatTimeLabel: typeof formatTimeLabel;
    timeToMinutes: typeof timeToMinutes;
    darkenColor: typeof darkenColor;
    softenColor: typeof softenColor;
    SOFTEN_AMOUNT: typeof SOFTEN_AMOUNT;
    findJob: typeof findJob;
    findTask: typeof findTask;
    getJobPhases: typeof getJobPhases;
    getPhaseSubUnits: typeof getPhaseSubUnits;
    getPhaseCard: typeof getPhaseCard;
    getJobCards: typeof getJobCards;
    getPrimaryPhaseCard: typeof getPrimaryPhaseCard;
  }
}

window.genId = genId;
window.safeJsonParse = safeJsonParse;
window.getDaysDiff = getDaysDiff;
window.toIsoDate = toIsoDate;
window.addMonths = addMonths;
window.getBusinessDaysDiff = getBusinessDaysDiff;
window.addBusinessDays = addBusinessDays;
window.formatTimeLabel = formatTimeLabel;
window.timeToMinutes = timeToMinutes;
window.darkenColor = darkenColor;
window.softenColor = softenColor;
window.SOFTEN_AMOUNT = SOFTEN_AMOUNT;
window.findJob = findJob;
window.findTask = findTask;
window.getJobPhases = getJobPhases;
window.getPhaseSubUnits = getPhaseSubUnits;
window.getPhaseCard = getPhaseCard;
window.getJobCards = getJobCards;
window.getPrimaryPhaseCard = getPrimaryPhaseCard;
