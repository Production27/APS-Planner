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
import { escapeHtml } from './utils/html';
import { createAutosaveController } from './utils/autosave';
import { findJob, findTask, getJobPhases, getPhaseSubUnits, getPhaseCard, getJobCards, getPrimaryPhaseCard } from './core/models';
import {
  handleColumnDragStart, handleColumnDragEnd, handleColumnReorderOver, handleColumnReorderLeave, handleColumnReorderDrop,
  getDragAfterColumn, syncColumnsFromDOM, handleCardDragStart, handleCardDragEnd, handleColumnDragOver, applyColumnDragOver,
  handleColumnDragLeave, dropNeedsManualOverride, handleColumnDrop, moveCardToColumn, getDragAfterElement, syncBoardCardsFromDOM,
  addBoardColumn, deleteBoardColumn, renameBoardColumn, isCardFromArchivedJob, isCardVisibleToMe,
  openWorkflowItemsModal, closeWorkflowItemsModal, renderWorkflowItemsBody, toggleWorkflowItemColorPanel, changeWorkflowItemColor,
  addWorkflowItem, removeWorkflowItem,
  resolveCardNameTarget, openEditCard, closeCardModal, scheduleCardAutosave, flushCardAutosave, cancelPendingCardAutosave,
  setCardTitleHint, autoSaveCardForm, initCardFormAutosaveListeners, deleteCardFromModal, renderBoard, buildCardEl,
} from './views/board';
import {
  isCalendarEventTaskId, parseCalendarEventTaskId, defaultRepeatUntil, getCalendarEventOccurrences,
  isCalendarEventVisibleToMe, flattenCalendarEventsForRange, ensureCalendarEventIds,
  openAddCalendarEvent, openEditCalendarEvent, closeCalendarEventModal, toggleRepeatUntilField,
  toggleCalendarEventVisibilityFields, collectCalendarEventVisibilityMembers, toggleCalendarEventColorPanel,
  updateCalendarEventColorSwatch, buildCalendarEventColorPresets, saveCalendarEventFromModal, deleteCalendarEventFromModal,
  setCalendarView, calendarPrev, calendarNext, calendarToday, calendarExitDayView, renderCalendar,
  buildCalBarHtml, renderMonthCalendar, renderWeekCalendar, renderWeekHourGrid, calendarOpenJob,
  getScheduledItemsForDate, openDayView, renderDayCalendarView,
  handleCalBarMouseDown, handleCalBarMouseMove, applyCalBarMouseMove, handleCalBarMouseUp,
} from './views/calendar';
import {
  cascadeShiftLaterTasks, startBarResizeRight, startBarResizeLeft, onBarResizeMove, applyBarResizeMove,
  onBarResizeEnd, startTickResize, onTickResizeMove, applyTickResizeMove, onTickResizeEnd,
  startBarMove, onBarMoveMove, applyBarMoveMove, onBarMoveEnd,
} from './views/gantt';

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
    handleColumnDragStart: typeof handleColumnDragStart;
    handleColumnDragEnd: typeof handleColumnDragEnd;
    handleColumnReorderOver: typeof handleColumnReorderOver;
    handleColumnReorderLeave: typeof handleColumnReorderLeave;
    handleColumnReorderDrop: typeof handleColumnReorderDrop;
    getDragAfterColumn: typeof getDragAfterColumn;
    syncColumnsFromDOM: typeof syncColumnsFromDOM;
    handleCardDragStart: typeof handleCardDragStart;
    handleCardDragEnd: typeof handleCardDragEnd;
    handleColumnDragOver: typeof handleColumnDragOver;
    applyColumnDragOver: typeof applyColumnDragOver;
    handleColumnDragLeave: typeof handleColumnDragLeave;
    dropNeedsManualOverride: typeof dropNeedsManualOverride;
    handleColumnDrop: typeof handleColumnDrop;
    moveCardToColumn: typeof moveCardToColumn;
    getDragAfterElement: typeof getDragAfterElement;
    syncBoardCardsFromDOM: typeof syncBoardCardsFromDOM;
    addBoardColumn: typeof addBoardColumn;
    deleteBoardColumn: typeof deleteBoardColumn;
    renameBoardColumn: typeof renameBoardColumn;
    isCardFromArchivedJob: typeof isCardFromArchivedJob;
    isCardVisibleToMe: typeof isCardVisibleToMe;
    escapeHtml: typeof escapeHtml;
    createAutosaveController: typeof createAutosaveController;
    openWorkflowItemsModal: typeof openWorkflowItemsModal;
    closeWorkflowItemsModal: typeof closeWorkflowItemsModal;
    renderWorkflowItemsBody: typeof renderWorkflowItemsBody;
    toggleWorkflowItemColorPanel: typeof toggleWorkflowItemColorPanel;
    changeWorkflowItemColor: typeof changeWorkflowItemColor;
    addWorkflowItem: typeof addWorkflowItem;
    removeWorkflowItem: typeof removeWorkflowItem;
    resolveCardNameTarget: typeof resolveCardNameTarget;
    openEditCard: typeof openEditCard;
    closeCardModal: typeof closeCardModal;
    scheduleCardAutosave: typeof scheduleCardAutosave;
    flushCardAutosave: typeof flushCardAutosave;
    cancelPendingCardAutosave: typeof cancelPendingCardAutosave;
    setCardTitleHint: typeof setCardTitleHint;
    autoSaveCardForm: typeof autoSaveCardForm;
    initCardFormAutosaveListeners: typeof initCardFormAutosaveListeners;
    deleteCardFromModal: typeof deleteCardFromModal;
    renderBoard: typeof renderBoard;
    buildCardEl: typeof buildCardEl;
    isCalendarEventTaskId: typeof isCalendarEventTaskId;
    parseCalendarEventTaskId: typeof parseCalendarEventTaskId;
    defaultRepeatUntil: typeof defaultRepeatUntil;
    getCalendarEventOccurrences: typeof getCalendarEventOccurrences;
    isCalendarEventVisibleToMe: typeof isCalendarEventVisibleToMe;
    flattenCalendarEventsForRange: typeof flattenCalendarEventsForRange;
    ensureCalendarEventIds: typeof ensureCalendarEventIds;
    openAddCalendarEvent: typeof openAddCalendarEvent;
    openEditCalendarEvent: typeof openEditCalendarEvent;
    closeCalendarEventModal: typeof closeCalendarEventModal;
    toggleRepeatUntilField: typeof toggleRepeatUntilField;
    toggleCalendarEventVisibilityFields: typeof toggleCalendarEventVisibilityFields;
    collectCalendarEventVisibilityMembers: typeof collectCalendarEventVisibilityMembers;
    toggleCalendarEventColorPanel: typeof toggleCalendarEventColorPanel;
    updateCalendarEventColorSwatch: typeof updateCalendarEventColorSwatch;
    buildCalendarEventColorPresets: typeof buildCalendarEventColorPresets;
    saveCalendarEventFromModal: typeof saveCalendarEventFromModal;
    deleteCalendarEventFromModal: typeof deleteCalendarEventFromModal;
    setCalendarView: typeof setCalendarView;
    calendarPrev: typeof calendarPrev;
    calendarNext: typeof calendarNext;
    calendarToday: typeof calendarToday;
    calendarExitDayView: typeof calendarExitDayView;
    renderCalendar: typeof renderCalendar;
    buildCalBarHtml: typeof buildCalBarHtml;
    renderMonthCalendar: typeof renderMonthCalendar;
    renderWeekCalendar: typeof renderWeekCalendar;
    renderWeekHourGrid: typeof renderWeekHourGrid;
    calendarOpenJob: typeof calendarOpenJob;
    getScheduledItemsForDate: typeof getScheduledItemsForDate;
    openDayView: typeof openDayView;
    renderDayCalendarView: typeof renderDayCalendarView;
    handleCalBarMouseDown: typeof handleCalBarMouseDown;
    handleCalBarMouseMove: typeof handleCalBarMouseMove;
    applyCalBarMouseMove: typeof applyCalBarMouseMove;
    handleCalBarMouseUp: typeof handleCalBarMouseUp;
    cascadeShiftLaterTasks: typeof cascadeShiftLaterTasks;
    startBarResizeRight: typeof startBarResizeRight;
    startBarResizeLeft: typeof startBarResizeLeft;
    onBarResizeMove: typeof onBarResizeMove;
    applyBarResizeMove: typeof applyBarResizeMove;
    onBarResizeEnd: typeof onBarResizeEnd;
    startTickResize: typeof startTickResize;
    onTickResizeMove: typeof onTickResizeMove;
    applyTickResizeMove: typeof applyTickResizeMove;
    onTickResizeEnd: typeof onTickResizeEnd;
    startBarMove: typeof startBarMove;
    onBarMoveMove: typeof onBarMoveMove;
    applyBarMoveMove: typeof applyBarMoveMove;
    onBarMoveEnd: typeof onBarMoveEnd;
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
window.handleColumnDragStart = handleColumnDragStart;
window.handleColumnDragEnd = handleColumnDragEnd;
window.handleColumnReorderOver = handleColumnReorderOver;
window.handleColumnReorderLeave = handleColumnReorderLeave;
window.handleColumnReorderDrop = handleColumnReorderDrop;
window.getDragAfterColumn = getDragAfterColumn;
window.syncColumnsFromDOM = syncColumnsFromDOM;
window.handleCardDragStart = handleCardDragStart;
window.handleCardDragEnd = handleCardDragEnd;
window.handleColumnDragOver = handleColumnDragOver;
window.applyColumnDragOver = applyColumnDragOver;
window.handleColumnDragLeave = handleColumnDragLeave;
window.dropNeedsManualOverride = dropNeedsManualOverride;
window.handleColumnDrop = handleColumnDrop;
window.moveCardToColumn = moveCardToColumn;
window.getDragAfterElement = getDragAfterElement;
window.syncBoardCardsFromDOM = syncBoardCardsFromDOM;
window.addBoardColumn = addBoardColumn;
window.deleteBoardColumn = deleteBoardColumn;
window.renameBoardColumn = renameBoardColumn;
window.isCardFromArchivedJob = isCardFromArchivedJob;
window.isCardVisibleToMe = isCardVisibleToMe;
window.escapeHtml = escapeHtml;
window.createAutosaveController = createAutosaveController;
window.openWorkflowItemsModal = openWorkflowItemsModal;
window.closeWorkflowItemsModal = closeWorkflowItemsModal;
window.renderWorkflowItemsBody = renderWorkflowItemsBody;
window.toggleWorkflowItemColorPanel = toggleWorkflowItemColorPanel;
window.changeWorkflowItemColor = changeWorkflowItemColor;
window.addWorkflowItem = addWorkflowItem;
window.removeWorkflowItem = removeWorkflowItem;
window.resolveCardNameTarget = resolveCardNameTarget;
window.openEditCard = openEditCard;
window.closeCardModal = closeCardModal;
window.scheduleCardAutosave = scheduleCardAutosave;
window.flushCardAutosave = flushCardAutosave;
window.cancelPendingCardAutosave = cancelPendingCardAutosave;
window.setCardTitleHint = setCardTitleHint;
window.autoSaveCardForm = autoSaveCardForm;
window.initCardFormAutosaveListeners = initCardFormAutosaveListeners;
window.deleteCardFromModal = deleteCardFromModal;
window.renderBoard = renderBoard;
window.buildCardEl = buildCardEl;
window.isCalendarEventTaskId = isCalendarEventTaskId;
window.parseCalendarEventTaskId = parseCalendarEventTaskId;
window.defaultRepeatUntil = defaultRepeatUntil;
window.getCalendarEventOccurrences = getCalendarEventOccurrences;
window.isCalendarEventVisibleToMe = isCalendarEventVisibleToMe;
window.flattenCalendarEventsForRange = flattenCalendarEventsForRange;
window.ensureCalendarEventIds = ensureCalendarEventIds;
window.openAddCalendarEvent = openAddCalendarEvent;
window.openEditCalendarEvent = openEditCalendarEvent;
window.closeCalendarEventModal = closeCalendarEventModal;
window.toggleRepeatUntilField = toggleRepeatUntilField;
window.toggleCalendarEventVisibilityFields = toggleCalendarEventVisibilityFields;
window.collectCalendarEventVisibilityMembers = collectCalendarEventVisibilityMembers;
window.toggleCalendarEventColorPanel = toggleCalendarEventColorPanel;
window.updateCalendarEventColorSwatch = updateCalendarEventColorSwatch;
window.buildCalendarEventColorPresets = buildCalendarEventColorPresets;
window.saveCalendarEventFromModal = saveCalendarEventFromModal;
window.deleteCalendarEventFromModal = deleteCalendarEventFromModal;
window.setCalendarView = setCalendarView;
window.calendarPrev = calendarPrev;
window.calendarNext = calendarNext;
window.calendarToday = calendarToday;
window.calendarExitDayView = calendarExitDayView;
window.renderCalendar = renderCalendar;
window.buildCalBarHtml = buildCalBarHtml;
window.renderMonthCalendar = renderMonthCalendar;
window.renderWeekCalendar = renderWeekCalendar;
window.renderWeekHourGrid = renderWeekHourGrid;
window.calendarOpenJob = calendarOpenJob;
window.getScheduledItemsForDate = getScheduledItemsForDate;
window.openDayView = openDayView;
window.renderDayCalendarView = renderDayCalendarView;
window.handleCalBarMouseDown = handleCalBarMouseDown;
window.handleCalBarMouseMove = handleCalBarMouseMove;
window.applyCalBarMouseMove = applyCalBarMouseMove;
window.handleCalBarMouseUp = handleCalBarMouseUp;
window.cascadeShiftLaterTasks = cascadeShiftLaterTasks;
window.startBarResizeRight = startBarResizeRight;
window.startBarResizeLeft = startBarResizeLeft;
window.onBarResizeMove = onBarResizeMove;
window.applyBarResizeMove = applyBarResizeMove;
window.onBarResizeEnd = onBarResizeEnd;
window.startTickResize = startTickResize;
window.onTickResizeMove = onTickResizeMove;
window.applyTickResizeMove = applyTickResizeMove;
window.onTickResizeEnd = onTickResizeEnd;
window.startBarMove = startBarMove;
window.onBarMoveMove = onBarMoveMove;
window.applyBarMoveMove = applyBarMoveMove;
window.onBarMoveEnd = onBarMoveEnd;
