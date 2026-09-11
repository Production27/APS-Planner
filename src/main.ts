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
  addWorkflowItem, removeWorkflowItem, handleColorSwatchKeydown,
  resolveCardNameTarget, openEditCard, closeCardModal, scheduleCardAutosave, flushCardAutosave, cancelPendingCardAutosave,
  setCardTitleHint, autoSaveCardForm, initCardFormAutosaveListeners, deleteCardFromModal, renderBoard, buildCardEl,
  isDarkColor, toggleColSettings, toggleColColorPanel, changeColumnColor, closeAllColSettings,
  toggleColumnScheduleVisibility, toggleColumnScheduleSync, toggleColumnFinishedTrigger, setColumnWorkflowItem,
  toggleColumnAutoAssignChecklist, setColumnChecklistAssignee, setColumnDefaultDuration, setColumnStalledThreshold,
  reconnectCard,
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
  initCalendarDragHandlers, calSwipeTargets, handleCalSwipeStart, handleCalSwipeMove,
  slideCalendarTargets, handleCalSwipeEnd, animateCalendarWheelChange, handleCalWheel,
} from './views/calendar';
import {
  cascadeShiftLaterTasks, startBarResizeRight, startBarResizeLeft, onBarResizeMove, applyBarResizeMove,
  onBarResizeEnd, startTickResize, onTickResizeMove, applyTickResizeMove, onTickResizeEnd,
  startBarMove, onBarMoveMove, applyBarMoveMove, onBarMoveEnd, buildVisibleTaskRows, renderGantt,
  scrollToToday, ganttTouchDist, setGanttDayWidthAnchored, requestGanttZoom, handleGanttTouchStart,
  handleGanttTouchMove, handleGanttTouchEnd, handleGanttWheelZoom, zoomGanttCentered, zoomIn, zoomOut,
  resetZoom, fitToView,
} from './views/gantt';
import {
  sendPresenceUpdate, presenceAvatarColor, presenceInitials, presenceAnimDelay, renderPresenceAvatars,
} from './sync/presence';
import {
  initSyncIndicator, setSyncIndicator, scheduleOfflineEscalation, cancelOfflineEscalation, isBusyEditing,
  handleRoomOpen, handleRoomClose, handleRoomSocketError, handleRoomSocketMessageEvent, setupLiveblocksSync,
} from './sync/connection';
import {
  queueSharedSync, flushPendingRoomPush, flushPendingSync, logout, sendRoomMessage, armStuckWriteWatch,
  clearPendingWrite, hasPendingWriteForProject, pushProjectToShared, removeProjectFromShared,
  pruneStrayEmptyProjects, deleteFromSharedMap, deleteJobFromShared, deleteCardFromShared,
  deleteCalendarEventFromShared, recordTombstone, pushFieldToShared, pushBoardColumnsToShared,
  pushFieldOptionsToShared, pushWorkflowItemsToShared, pushHeaderToShared, logActivity, pushLiveblocksState,
} from './sync/outbound';
import {
  handleRoomMessage, synthesizeJobFromOrphanCard, safeMergeInto, scheduleOrphanRecovery, healOrphanedJobCards,
  healOrphanedPhaseCards, healOrphanedCardsForProject, applyRoomSnapshot, refreshActiveProjectFromShared,
} from './sync/inbound';
import {
  ensureCardChecklists, normalizeChecklistAssignees, isChecklistStageVisibleToMe,
  getOpenChecklistItemsForCard, confirmChecklistBeforeMove, canAssignChecklistStages,
  openManageColumnChecklist, closeManageColumnChecklist, renderManageColumnChecklistBody,
  addColumnChecklistDefaultItem, removeColumnChecklistDefaultItem, getChecklistForStageInProject,
  buildMyChecklistRows, myChecklistMsDropdownHtml, renderMyChecklistList, toggleMyChecklistHideDone,
  myChecklistAddableCards, renderMyChecklistToolbar, renderMyChecklistFilterBar, onMyChecklistContextChange,
  addMyChecklistItemFromBar, buildMyChecklistJobRows, renderMyChecklist, updateMyChecklistBadge,
  openMyChecklistItem, resolveMyChecklistCard, persistMyChecklistChange, withMyChecklistItem,
  toggleMyChecklistItemDone, toggleMyChecklistItemRequired, toggleMyChecklistSubItemDone,
  addMyChecklistSubItem, deleteMyChecklistSubItem, addMyChecklistItem, deleteMyChecklistItem,
  setMyChecklistItemAssignee, setMyChecklistStageAssignee,
} from './views/checklist';
import {
  getActiveTab, switchTabMorphed, homeWidgetGoTo, clearHomeTabMorphNames, switchTab, toggleJobRail, setMobileView,
  applyHomeReflowTracks, toggleHomeWidgetExpand, buildHomeOverdueRows, buildHomeStalledRows, buildHomeStageSummary,
  buildHomeTodayScheduleRows, buildHomeUpcomingScheduleRows, buildHomeGanttUnclosedRows, renderHomeGreeting,
  renderHomeChecklistWidget, renderHomeChecklistWidgetExpanded, getDismissedHomeWidgetAlerts,
  isHomeWidgetAlertDismissed, dismissHomeWidgetAlert, renderHomeWidgetAlert, renderHomeOverdueWidget,
  renderHomeCalendarExpanded, renderHomeCalendarMiniMonth, renderHomeWorkflowMiniBoard,
  renderHomeWorkflowExpandedBoard, renderHomeTodayScheduleWidget, buildHomeJobChatFeed,
  renderHomeJobChatComposeOptions, renderHomeJobChatItem, renderHomeJobChat, postHomeJobChatComment,
  toggleHomeReplyBox, addHomeJobReply, handleHomeReplyKey, renderHomeDashboard,
} from './views/home';

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
    handleColorSwatchKeydown: typeof handleColorSwatchKeydown;
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
    isDarkColor: typeof isDarkColor;
    toggleColSettings: typeof toggleColSettings;
    toggleColColorPanel: typeof toggleColColorPanel;
    changeColumnColor: typeof changeColumnColor;
    closeAllColSettings: typeof closeAllColSettings;
    toggleColumnScheduleVisibility: typeof toggleColumnScheduleVisibility;
    toggleColumnScheduleSync: typeof toggleColumnScheduleSync;
    toggleColumnFinishedTrigger: typeof toggleColumnFinishedTrigger;
    setColumnWorkflowItem: typeof setColumnWorkflowItem;
    toggleColumnAutoAssignChecklist: typeof toggleColumnAutoAssignChecklist;
    setColumnChecklistAssignee: typeof setColumnChecklistAssignee;
    setColumnDefaultDuration: typeof setColumnDefaultDuration;
    setColumnStalledThreshold: typeof setColumnStalledThreshold;
    reconnectCard: typeof reconnectCard;
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
    initCalendarDragHandlers: typeof initCalendarDragHandlers;
    calSwipeTargets: typeof calSwipeTargets;
    handleCalSwipeStart: typeof handleCalSwipeStart;
    handleCalSwipeMove: typeof handleCalSwipeMove;
    slideCalendarTargets: typeof slideCalendarTargets;
    handleCalSwipeEnd: typeof handleCalSwipeEnd;
    animateCalendarWheelChange: typeof animateCalendarWheelChange;
    handleCalWheel: typeof handleCalWheel;
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
    buildVisibleTaskRows: typeof buildVisibleTaskRows;
    renderGantt: typeof renderGantt;
    scrollToToday: typeof scrollToToday;
    ganttTouchDist: typeof ganttTouchDist;
    setGanttDayWidthAnchored: typeof setGanttDayWidthAnchored;
    requestGanttZoom: typeof requestGanttZoom;
    handleGanttTouchStart: typeof handleGanttTouchStart;
    handleGanttTouchMove: typeof handleGanttTouchMove;
    handleGanttTouchEnd: typeof handleGanttTouchEnd;
    handleGanttWheelZoom: typeof handleGanttWheelZoom;
    zoomGanttCentered: typeof zoomGanttCentered;
    zoomIn: typeof zoomIn;
    zoomOut: typeof zoomOut;
    resetZoom: typeof resetZoom;
    fitToView: typeof fitToView;
    sendPresenceUpdate: typeof sendPresenceUpdate;
    presenceAvatarColor: typeof presenceAvatarColor;
    presenceInitials: typeof presenceInitials;
    presenceAnimDelay: typeof presenceAnimDelay;
    renderPresenceAvatars: typeof renderPresenceAvatars;
    initSyncIndicator: typeof initSyncIndicator;
    setSyncIndicator: typeof setSyncIndicator;
    scheduleOfflineEscalation: typeof scheduleOfflineEscalation;
    cancelOfflineEscalation: typeof cancelOfflineEscalation;
    isBusyEditing: typeof isBusyEditing;
    handleRoomOpen: typeof handleRoomOpen;
    handleRoomClose: typeof handleRoomClose;
    handleRoomSocketError: typeof handleRoomSocketError;
    handleRoomSocketMessageEvent: typeof handleRoomSocketMessageEvent;
    setupLiveblocksSync: typeof setupLiveblocksSync;
    queueSharedSync: typeof queueSharedSync;
    flushPendingRoomPush: typeof flushPendingRoomPush;
    flushPendingSync: typeof flushPendingSync;
    logout: typeof logout;
    sendRoomMessage: typeof sendRoomMessage;
    armStuckWriteWatch: typeof armStuckWriteWatch;
    clearPendingWrite: typeof clearPendingWrite;
    hasPendingWriteForProject: typeof hasPendingWriteForProject;
    pushProjectToShared: typeof pushProjectToShared;
    removeProjectFromShared: typeof removeProjectFromShared;
    pruneStrayEmptyProjects: typeof pruneStrayEmptyProjects;
    deleteFromSharedMap: typeof deleteFromSharedMap;
    deleteJobFromShared: typeof deleteJobFromShared;
    deleteCardFromShared: typeof deleteCardFromShared;
    deleteCalendarEventFromShared: typeof deleteCalendarEventFromShared;
    recordTombstone: typeof recordTombstone;
    pushFieldToShared: typeof pushFieldToShared;
    pushBoardColumnsToShared: typeof pushBoardColumnsToShared;
    pushFieldOptionsToShared: typeof pushFieldOptionsToShared;
    pushWorkflowItemsToShared: typeof pushWorkflowItemsToShared;
    pushHeaderToShared: typeof pushHeaderToShared;
    logActivity: typeof logActivity;
    pushLiveblocksState: typeof pushLiveblocksState;
    handleRoomMessage: typeof handleRoomMessage;
    synthesizeJobFromOrphanCard: typeof synthesizeJobFromOrphanCard;
    safeMergeInto: typeof safeMergeInto;
    scheduleOrphanRecovery: typeof scheduleOrphanRecovery;
    healOrphanedJobCards: typeof healOrphanedJobCards;
    healOrphanedPhaseCards: typeof healOrphanedPhaseCards;
    healOrphanedCardsForProject: typeof healOrphanedCardsForProject;
    applyRoomSnapshot: typeof applyRoomSnapshot;
    refreshActiveProjectFromShared: typeof refreshActiveProjectFromShared;
    ensureCardChecklists: typeof ensureCardChecklists;
    normalizeChecklistAssignees: typeof normalizeChecklistAssignees;
    isChecklistStageVisibleToMe: typeof isChecklistStageVisibleToMe;
    getOpenChecklistItemsForCard: typeof getOpenChecklistItemsForCard;
    confirmChecklistBeforeMove: typeof confirmChecklistBeforeMove;
    canAssignChecklistStages: typeof canAssignChecklistStages;
    openManageColumnChecklist: typeof openManageColumnChecklist;
    closeManageColumnChecklist: typeof closeManageColumnChecklist;
    renderManageColumnChecklistBody: typeof renderManageColumnChecklistBody;
    addColumnChecklistDefaultItem: typeof addColumnChecklistDefaultItem;
    removeColumnChecklistDefaultItem: typeof removeColumnChecklistDefaultItem;
    getChecklistForStageInProject: typeof getChecklistForStageInProject;
    buildMyChecklistRows: typeof buildMyChecklistRows;
    myChecklistMsDropdownHtml: typeof myChecklistMsDropdownHtml;
    renderMyChecklistList: typeof renderMyChecklistList;
    toggleMyChecklistHideDone: typeof toggleMyChecklistHideDone;
    myChecklistAddableCards: typeof myChecklistAddableCards;
    renderMyChecklistToolbar: typeof renderMyChecklistToolbar;
    renderMyChecklistFilterBar: typeof renderMyChecklistFilterBar;
    onMyChecklistContextChange: typeof onMyChecklistContextChange;
    addMyChecklistItemFromBar: typeof addMyChecklistItemFromBar;
    buildMyChecklistJobRows: typeof buildMyChecklistJobRows;
    renderMyChecklist: typeof renderMyChecklist;
    updateMyChecklistBadge: typeof updateMyChecklistBadge;
    openMyChecklistItem: typeof openMyChecklistItem;
    resolveMyChecklistCard: typeof resolveMyChecklistCard;
    persistMyChecklistChange: typeof persistMyChecklistChange;
    withMyChecklistItem: typeof withMyChecklistItem;
    toggleMyChecklistItemDone: typeof toggleMyChecklistItemDone;
    toggleMyChecklistItemRequired: typeof toggleMyChecklistItemRequired;
    toggleMyChecklistSubItemDone: typeof toggleMyChecklistSubItemDone;
    addMyChecklistSubItem: typeof addMyChecklistSubItem;
    deleteMyChecklistSubItem: typeof deleteMyChecklistSubItem;
    addMyChecklistItem: typeof addMyChecklistItem;
    deleteMyChecklistItem: typeof deleteMyChecklistItem;
    setMyChecklistItemAssignee: typeof setMyChecklistItemAssignee;
    setMyChecklistStageAssignee: typeof setMyChecklistStageAssignee;
    getActiveTab: typeof getActiveTab;
    switchTabMorphed: typeof switchTabMorphed;
    homeWidgetGoTo: typeof homeWidgetGoTo;
    clearHomeTabMorphNames: typeof clearHomeTabMorphNames;
    switchTab: typeof switchTab;
    toggleJobRail: typeof toggleJobRail;
    setMobileView: typeof setMobileView;
    applyHomeReflowTracks: typeof applyHomeReflowTracks;
    toggleHomeWidgetExpand: typeof toggleHomeWidgetExpand;
    buildHomeOverdueRows: typeof buildHomeOverdueRows;
    buildHomeStalledRows: typeof buildHomeStalledRows;
    buildHomeStageSummary: typeof buildHomeStageSummary;
    buildHomeTodayScheduleRows: typeof buildHomeTodayScheduleRows;
    buildHomeUpcomingScheduleRows: typeof buildHomeUpcomingScheduleRows;
    buildHomeGanttUnclosedRows: typeof buildHomeGanttUnclosedRows;
    renderHomeGreeting: typeof renderHomeGreeting;
    renderHomeChecklistWidget: typeof renderHomeChecklistWidget;
    renderHomeChecklistWidgetExpanded: typeof renderHomeChecklistWidgetExpanded;
    getDismissedHomeWidgetAlerts: typeof getDismissedHomeWidgetAlerts;
    isHomeWidgetAlertDismissed: typeof isHomeWidgetAlertDismissed;
    dismissHomeWidgetAlert: typeof dismissHomeWidgetAlert;
    renderHomeWidgetAlert: typeof renderHomeWidgetAlert;
    renderHomeOverdueWidget: typeof renderHomeOverdueWidget;
    renderHomeCalendarExpanded: typeof renderHomeCalendarExpanded;
    renderHomeCalendarMiniMonth: typeof renderHomeCalendarMiniMonth;
    renderHomeWorkflowMiniBoard: typeof renderHomeWorkflowMiniBoard;
    renderHomeWorkflowExpandedBoard: typeof renderHomeWorkflowExpandedBoard;
    renderHomeTodayScheduleWidget: typeof renderHomeTodayScheduleWidget;
    buildHomeJobChatFeed: typeof buildHomeJobChatFeed;
    renderHomeJobChatComposeOptions: typeof renderHomeJobChatComposeOptions;
    renderHomeJobChatItem: typeof renderHomeJobChatItem;
    renderHomeJobChat: typeof renderHomeJobChat;
    postHomeJobChatComment: typeof postHomeJobChatComment;
    toggleHomeReplyBox: typeof toggleHomeReplyBox;
    addHomeJobReply: typeof addHomeJobReply;
    handleHomeReplyKey: typeof handleHomeReplyKey;
    renderHomeDashboard: typeof renderHomeDashboard;
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
window.handleColorSwatchKeydown = handleColorSwatchKeydown;
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
window.isDarkColor = isDarkColor;
window.toggleColSettings = toggleColSettings;
window.toggleColColorPanel = toggleColColorPanel;
window.changeColumnColor = changeColumnColor;
window.closeAllColSettings = closeAllColSettings;
window.toggleColumnScheduleVisibility = toggleColumnScheduleVisibility;
window.toggleColumnScheduleSync = toggleColumnScheduleSync;
window.toggleColumnFinishedTrigger = toggleColumnFinishedTrigger;
window.setColumnWorkflowItem = setColumnWorkflowItem;
window.toggleColumnAutoAssignChecklist = toggleColumnAutoAssignChecklist;
window.setColumnChecklistAssignee = setColumnChecklistAssignee;
window.setColumnDefaultDuration = setColumnDefaultDuration;
window.setColumnStalledThreshold = setColumnStalledThreshold;
window.reconnectCard = reconnectCard;
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
window.initCalendarDragHandlers = initCalendarDragHandlers;
window.calSwipeTargets = calSwipeTargets;
window.handleCalSwipeStart = handleCalSwipeStart;
window.handleCalSwipeMove = handleCalSwipeMove;
window.slideCalendarTargets = slideCalendarTargets;
window.handleCalSwipeEnd = handleCalSwipeEnd;
window.animateCalendarWheelChange = animateCalendarWheelChange;
window.handleCalWheel = handleCalWheel;
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
window.buildVisibleTaskRows = buildVisibleTaskRows;
window.renderGantt = renderGantt;
window.scrollToToday = scrollToToday;
window.ganttTouchDist = ganttTouchDist;
window.setGanttDayWidthAnchored = setGanttDayWidthAnchored;
window.requestGanttZoom = requestGanttZoom;
window.handleGanttTouchStart = handleGanttTouchStart;
window.handleGanttTouchMove = handleGanttTouchMove;
window.handleGanttTouchEnd = handleGanttTouchEnd;
window.handleGanttWheelZoom = handleGanttWheelZoom;
window.zoomGanttCentered = zoomGanttCentered;
window.zoomIn = zoomIn;
window.zoomOut = zoomOut;
window.resetZoom = resetZoom;
window.fitToView = fitToView;
window.sendPresenceUpdate = sendPresenceUpdate;
window.presenceAvatarColor = presenceAvatarColor;
window.presenceInitials = presenceInitials;
window.presenceAnimDelay = presenceAnimDelay;
window.renderPresenceAvatars = renderPresenceAvatars;
window.initSyncIndicator = initSyncIndicator;
window.setSyncIndicator = setSyncIndicator;
window.scheduleOfflineEscalation = scheduleOfflineEscalation;
window.cancelOfflineEscalation = cancelOfflineEscalation;
window.isBusyEditing = isBusyEditing;
window.handleRoomOpen = handleRoomOpen;
window.handleRoomClose = handleRoomClose;
window.handleRoomSocketError = handleRoomSocketError;
window.handleRoomSocketMessageEvent = handleRoomSocketMessageEvent;
window.setupLiveblocksSync = setupLiveblocksSync;
window.queueSharedSync = queueSharedSync;
window.flushPendingRoomPush = flushPendingRoomPush;
window.flushPendingSync = flushPendingSync;
window.logout = logout;
window.sendRoomMessage = sendRoomMessage;
window.armStuckWriteWatch = armStuckWriteWatch;
window.clearPendingWrite = clearPendingWrite;
window.hasPendingWriteForProject = hasPendingWriteForProject;
window.pushProjectToShared = pushProjectToShared;
window.removeProjectFromShared = removeProjectFromShared;
window.pruneStrayEmptyProjects = pruneStrayEmptyProjects;
window.deleteFromSharedMap = deleteFromSharedMap;
window.deleteJobFromShared = deleteJobFromShared;
window.deleteCardFromShared = deleteCardFromShared;
window.deleteCalendarEventFromShared = deleteCalendarEventFromShared;
window.recordTombstone = recordTombstone;
window.pushFieldToShared = pushFieldToShared;
window.pushBoardColumnsToShared = pushBoardColumnsToShared;
window.pushFieldOptionsToShared = pushFieldOptionsToShared;
window.pushWorkflowItemsToShared = pushWorkflowItemsToShared;
window.pushHeaderToShared = pushHeaderToShared;
window.logActivity = logActivity;
window.pushLiveblocksState = pushLiveblocksState;
window.handleRoomMessage = handleRoomMessage;
window.synthesizeJobFromOrphanCard = synthesizeJobFromOrphanCard;
window.safeMergeInto = safeMergeInto;
window.scheduleOrphanRecovery = scheduleOrphanRecovery;
window.healOrphanedJobCards = healOrphanedJobCards;
window.healOrphanedPhaseCards = healOrphanedPhaseCards;
window.healOrphanedCardsForProject = healOrphanedCardsForProject;
window.applyRoomSnapshot = applyRoomSnapshot;
window.refreshActiveProjectFromShared = refreshActiveProjectFromShared;
window.ensureCardChecklists = ensureCardChecklists;
window.normalizeChecklistAssignees = normalizeChecklistAssignees;
window.isChecklistStageVisibleToMe = isChecklistStageVisibleToMe;
window.getOpenChecklistItemsForCard = getOpenChecklistItemsForCard;
window.confirmChecklistBeforeMove = confirmChecklistBeforeMove;
window.canAssignChecklistStages = canAssignChecklistStages;
window.openManageColumnChecklist = openManageColumnChecklist;
window.closeManageColumnChecklist = closeManageColumnChecklist;
window.renderManageColumnChecklistBody = renderManageColumnChecklistBody;
window.addColumnChecklistDefaultItem = addColumnChecklistDefaultItem;
window.removeColumnChecklistDefaultItem = removeColumnChecklistDefaultItem;
window.getChecklistForStageInProject = getChecklistForStageInProject;
window.buildMyChecklistRows = buildMyChecklistRows;
window.myChecklistMsDropdownHtml = myChecklistMsDropdownHtml;
window.renderMyChecklistList = renderMyChecklistList;
window.toggleMyChecklistHideDone = toggleMyChecklistHideDone;
window.myChecklistAddableCards = myChecklistAddableCards;
window.renderMyChecklistToolbar = renderMyChecklistToolbar;
window.renderMyChecklistFilterBar = renderMyChecklistFilterBar;
window.onMyChecklistContextChange = onMyChecklistContextChange;
window.addMyChecklistItemFromBar = addMyChecklistItemFromBar;
window.buildMyChecklistJobRows = buildMyChecklistJobRows;
window.renderMyChecklist = renderMyChecklist;
window.updateMyChecklistBadge = updateMyChecklistBadge;
window.openMyChecklistItem = openMyChecklistItem;
window.resolveMyChecklistCard = resolveMyChecklistCard;
window.persistMyChecklistChange = persistMyChecklistChange;
window.withMyChecklistItem = withMyChecklistItem;
window.toggleMyChecklistItemDone = toggleMyChecklistItemDone;
window.toggleMyChecklistItemRequired = toggleMyChecklistItemRequired;
window.toggleMyChecklistSubItemDone = toggleMyChecklistSubItemDone;
window.addMyChecklistSubItem = addMyChecklistSubItem;
window.deleteMyChecklistSubItem = deleteMyChecklistSubItem;
window.addMyChecklistItem = addMyChecklistItem;
window.deleteMyChecklistItem = deleteMyChecklistItem;
window.setMyChecklistItemAssignee = setMyChecklistItemAssignee;
window.setMyChecklistStageAssignee = setMyChecklistStageAssignee;
window.getActiveTab = getActiveTab;
window.switchTabMorphed = switchTabMorphed;
window.homeWidgetGoTo = homeWidgetGoTo;
window.clearHomeTabMorphNames = clearHomeTabMorphNames;
window.switchTab = switchTab;
window.toggleJobRail = toggleJobRail;
window.setMobileView = setMobileView;
window.applyHomeReflowTracks = applyHomeReflowTracks;
window.toggleHomeWidgetExpand = toggleHomeWidgetExpand;
window.buildHomeOverdueRows = buildHomeOverdueRows;
window.buildHomeStalledRows = buildHomeStalledRows;
window.buildHomeStageSummary = buildHomeStageSummary;
window.buildHomeTodayScheduleRows = buildHomeTodayScheduleRows;
window.buildHomeUpcomingScheduleRows = buildHomeUpcomingScheduleRows;
window.buildHomeGanttUnclosedRows = buildHomeGanttUnclosedRows;
window.renderHomeGreeting = renderHomeGreeting;
window.renderHomeChecklistWidget = renderHomeChecklistWidget;
window.renderHomeChecklistWidgetExpanded = renderHomeChecklistWidgetExpanded;
window.getDismissedHomeWidgetAlerts = getDismissedHomeWidgetAlerts;
window.isHomeWidgetAlertDismissed = isHomeWidgetAlertDismissed;
window.dismissHomeWidgetAlert = dismissHomeWidgetAlert;
window.renderHomeWidgetAlert = renderHomeWidgetAlert;
window.renderHomeOverdueWidget = renderHomeOverdueWidget;
window.renderHomeCalendarExpanded = renderHomeCalendarExpanded;
window.renderHomeCalendarMiniMonth = renderHomeCalendarMiniMonth;
window.renderHomeWorkflowMiniBoard = renderHomeWorkflowMiniBoard;
window.renderHomeWorkflowExpandedBoard = renderHomeWorkflowExpandedBoard;
window.renderHomeTodayScheduleWidget = renderHomeTodayScheduleWidget;
window.buildHomeJobChatFeed = buildHomeJobChatFeed;
window.renderHomeJobChatComposeOptions = renderHomeJobChatComposeOptions;
window.renderHomeJobChatItem = renderHomeJobChatItem;
window.renderHomeJobChat = renderHomeJobChat;
window.postHomeJobChatComment = postHomeJobChatComment;
window.toggleHomeReplyBox = toggleHomeReplyBox;
window.addHomeJobReply = addHomeJobReply;
window.handleHomeReplyKey = handleHomeReplyKey;
window.renderHomeDashboard = renderHomeDashboard;
