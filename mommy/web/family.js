/*
 * family.js: the family UI of Mommy (docs/REWARDS.md, "Web client"), on top of
 * rewards.js (window.MommyRewards: the pure logic) and app.js (window.MommyApp: the
 * existing screens and the hooks below).
 *
 * Screens drawn here: 'start' (the family setup on the first run), 'who' (who is
 * learning?), 'home' (the child's tasks and star jar) and 'parent' (the parent area,
 * behind the PIN). The task runner opens app.js's recite, dictation and Quran screens
 * preloaded (MommyApp.startTask) and records every check result (recordAttempt).
 *
 * (Redesign) Also 'texts' (My texts: the child's saved texts) and the child's own new
 * profile on 'who'. The parent area has four sections: Tasks (optional suggestions:
 * create, edit, archive, "Mark as done", "Take the stars back", details), Rewards (per child: the jar and its history,
 * task rewards to give, goals, surprises, corrections), Children, and Settings (consent,
 * change the PIN, the parent's language, a copy of the family list, delete all data on
 * this device).
 *
 * A copy of the family list: the document is per browser and per address, so a new
 * address (a quick tunnel after a restart) starts empty. Settings saves a copy as a file
 * (a Blob URL and <a download>: no new origin, nothing sent to the server) and loads one
 * ("Replace", the PIN and the consents of this device stay); the first-run setup loads
 * one instead of a first child (the consents and a PIN are still given there). The file
 * never holds the PIN record or a consent (rewards.js makeFamilyCopy), and a loaded copy
 * goes through validateDoc like stored data (readFamilyCopy).
 *
 * Consent: the general box (microphone and camera) and, while Claude is set up, a box of
 * its own under the Claude notice (the AI consent, R.hasAiConsent). A consent given
 * while Claude was not set up, or saved before the AI consent had its own box, never
 * covers Claude: until the parent ticks that box (the setup, Settings, or the prompt at
 * the top of the parent area), app.js keeps every Claude call off.
 *
 * Handshake (independent of the script order): this file sets window.MommyFamily =
 * {attach}; app.js calls attach(MommyApp) when it starts, and if app.js already ran,
 * this file attaches at once. attach() runs once.
 *
 * Storage: ONE place loads and saves the family document (`store`, `commit`):
 *   - load: validateDoc; a document that cannot be read, or that needed repairs, is
 *     first kept under 'mommy.data.v2.corrupt.<time>' (never overwritten silently), with
 *     a notice for the parent; a v1 profile is migrated and its key removed once the v2
 *     document is saved;
 *   - save: after every change; QuotaExceededError and blocked storage give a visible
 *     notice (the session goes on in memory);
 *   - the 'storage' event (another tab) reloads the document and re-renders.
 * Only scores are stored for an attempt (rewards.js); never audio, photos or
 * transcripts, and nothing of that is logged.
 *
 * Rendering: text entered by a parent or a child (nicknames, titles, task texts, reward
 * texts, notes, emoji) only ever goes into the page through textContent and DOM nodes
 * (app.el), never innerHTML; inside a translated sentence it is a <bdi> of its own.
 */
(function () {
  'use strict';

  // ===========================================================================
  // UI strings (en / fr / ar), added to app.js's tables: keys start with "fam_".
  // Arabic: gender-neutral; يُرجى + verbal noun for the parent; هيا + "we" for the
  // child; verbal nouns on buttons; Arabic-Indic digits.
  // ===========================================================================

  const STRINGS = {
    en: {
      fam_tf_text_empty: 'Please type or paste some text first.',
      fam_more_setup: 'More: privacy, a copy of the family list',
      fam_led_practice_gone: 'Practice',
      fam_led_practice_quran: 'Practice: Quran',
      fam_led_practice: 'Practice: {title}',
      fam_led_undo_gone: 'Stars taken back',
      fam_led_undo: 'Taken back: {title}',
      fam_undone: 'The stars were taken back: the task is to do again.',
      fam_undo_q: 'Take back the stars of this task? It goes back to “To do”, and its reward is locked again.',
      fam_undo: 'Take the stars back',
      fam_mark_done_hint: 'If the app misheard and you saw your child do it, you can mark it as done: its stars go into the jar.',
      fam_mark_done: 'Mark as done',
      fam_tf_more: 'More options (title, pass level, reward, date)',
      fam_tasks_about: 'Optional: suggestions for a child. The app gives the stars when the child does it; children can always practise freely too.',
      texts_mode_words: 'word by word',
      texts_mode_meaning: 'by meaning',
      texts_deleted: 'The text was deleted.',
      texts_delete_q: 'Delete this text? Its stars stay in the jar.',
      texts_delete: 'Delete',
      texts_edit: 'Change',
      texts_dict: 'Dictation',
      texts_read: 'Read aloud',
      texts_full: 'There are already {n} texts. Let’s delete one first.',
      texts_empty: 'No text yet. Press “New text” to add one.',
      texts_new: 'New text',
      texts_lead: 'Save a text once, then read it aloud or write it as a dictation, as often as you like.',
      texts_title: 'My texts',
      fam_practice_limit: 'Well done! The stars of practice for today are all earned: more tomorrow.',
      fam_practice_again: 'Well done! The star for this one was already earned today.',
      fam_practice_star: 'Well done! A star for the jar: ⭐',
      fam_wa_err_name: 'Let’s type a name first.',
      fam_wa_save: 'Add me',
      fam_wa_lang: 'Language',
      fam_wa_name: 'Name',
      fam_who_add_title: 'A new learner',
      fam_who_add: 'I’m new: add me',
      fam_more: 'More',
      fam_privacy_short: 'The family list (children, texts, stars, rewards and the PIN) stays in this browser, on this device.',
      fam_setup_more_children: 'More children can add themselves later, on “Who is learning?”.',
      fam_task_word_by_word: 'The task is now recited word by word.',
      fam_make_word_by_word: 'Recite word by word',
      fam_detail_meaning_quran: 'This task is by meaning, but its text has words of the Quran, which are recited word by word only: the child cannot do it as it is.',
      fam_keep: 'Keep it',
      fam_goal_remove_q: 'Remove this goal? The stars in the jar stay as they are.',
      fam_archive_q: 'Archive this task? It leaves the lists, and it cannot be brought back.',
      fam_improve_many: '{n} more words right than last time!',
      fam_improve_few: '{n} more words right than last time!',
      fam_improve_two: '{n} more words right than last time!',
      fam_detail_anyway_dictation: 'The paper is checked in “Mom’s check” at the end of the dictation. If you have checked the paper yourself another time and it is right, you can mark the task as done.',
      fam_err_quran_meaning_diff: 'This text has words of the Quran, recited word by word only: “Word by word” is now chosen. Some of them are not as in the mushaf (see the note under the text). Please use the mushaf text before saving.',
      fam_err_quran_diff_recite: 'Some words of the Quran in this text are not as in the mushaf: see the note under the text. Please use the mushaf text before saving.',
      fam_setup_lead: 'Set up once, for the whole family: it takes a minute.',
      fam_setup_title: 'Family setup',
      fam_parent_lang: 'Language for the grown-ups',
      fam_pin_legend: 'Parent PIN',
      fam_pin_about: 'The PIN is a child lock: it keeps the parent area for the grown-ups. It has 4 to 6 digits.',
      fam_pin_new: 'New PIN',
      fam_pin_again: 'The same PIN again',
      fam_first_child: 'The first child',
      fam_child_lang: 'Language of the child',
      fam_avatar: 'Picture',
      fam_err_nickname: 'Please type a nickname.',
      fam_err_pin_format: 'A PIN has 4 to 6 digits.',
      fam_err_pin_same: 'The two PINs are not the same. Please type them again.',
      fam_err_crypto: 'The PIN cannot be used on this page: it needs https or localhost.',
      fam_saving: 'Saving…',
      fam_ok: 'OK',
      fam_notice_corrupt: 'The family data saved on this device could not be read. It was kept aside on this device, and a fresh start was made.',
      fam_notice_repaired: 'Some family data on this device was damaged and has been repaired. A copy of the old data was kept on this device.',
      fam_notice_quota: 'The storage of this browser is full, so the last change could not be saved. Please free some space (for example old site data), then try again.',
      fam_notice_memory: 'This browser does not allow saving here (private mode?). Everything works until the page is closed; then the data is lost.',
      fam_who_title: 'Who is learning?',
      fam_who_empty: 'No one here yet: let’s add the first profile.',
      fam_for_parents: 'For parents',
      fam_jar: 'Stars in the jar: {n}',
      fam_goal_missing: '{n} more stars to: {reward}',
      fam_goal_missing_one: '{n} more star to: {reward}',
      fam_goal_reached: 'Enough stars for: {reward}! Tell your parent.',
      fam_todo: 'From your parent',
      fam_done: 'My trophies',
      fam_free: 'Practise',
      fam_switch_child: 'Change child',
      fam_kind_recite: 'Recite',
      fam_kind_dictation: 'Dictation',
      fam_kind_quran: 'Quran',
      fam_stars_n: 'Stars: {n}',
      fam_due: 'For {date}',
      fam_reward_label: 'Reward:',
      fam_note_label: 'Note:',
      fam_start: 'Start',
      fam_pass_all_words: 'All words right',
      fam_pass_nine_in_ten: '9 of 10 words',
      fam_pass_eight_in_ten: '8 of 10 words',
      fam_pass_same_meaning: 'Same meaning',
      fam_pass_line: 'Pass: {rule}',
      fam_reward_unlocked: 'Earned! Your parent will give it.',
      fam_reward_given: 'Received',
      fam_surprise_title: 'A surprise for you!',
      fam_surprise_ok: 'Thank you!',
      fam_task_banner_label: 'Task',
      fam_task_leave: 'Back home',
      fam_celebrate: 'Well done! {stars} are in your jar.',
      fam_celebrate_reward: 'Well done! {stars} are in your jar, and {reward} is earned: your parent will give it.',
      fam_improve: '{n} more words right than last time!',
      fam_improve_one: '{n} more word right than last time!',
      fam_try_again: 'Try again whenever you are ready.',
      fam_pin_enter_title: 'Parent area',
      fam_pin_enter_intro: 'Please type the parent PIN. It is a child lock: it keeps this area for the grown-ups.',
      fam_pin_label: 'PIN',
      fam_pin_create_title: 'Create the parent PIN',
      fam_pin_create_intro: 'Please choose a PIN of 4 to 6 digits and type it twice. It is a child lock: it keeps the parent area for the grown-ups.',
      fam_pin_reset_intro: 'All the data is kept. Please choose a new PIN and type it twice; the old PIN works until the new one is saved.',
      fam_unlock: 'Open',
      fam_confirm: 'Confirm',
      fam_create: 'Create',
      fam_cancel: 'Cancel',
      fam_forgot: 'Forgot the PIN?',
      fam_pin_wrong: 'Wrong PIN. Tries left before a pause: {n}.',
      fam_pin_wrong_last: 'Wrong PIN.',
      fam_pin_locked: 'Too many tries. Please wait {time} before trying again.',
      fam_pin_checking: 'Checking…',
      fam_gate_title: 'Forgot the PIN',
      fam_gate_intro: 'To make a new PIN, please answer this question for grown-ups. All the data is kept.',
      fam_gate_q: 'How much is {a} times {b}? Please type the answer in digits.',
      fam_gate_wrong: 'That is not the answer. Here is another question.',
      fam_gate_check: 'Check',
      fam_n3: 'three',
      fam_n4: 'four',
      fam_n5: 'five',
      fam_n6: 'six',
      fam_n7: 'seven',
      fam_n8: 'eight',
      fam_n9: 'nine',
      fam_t2: 'twenty',
      fam_t3: 'thirty',
      fam_t4: 'forty',
      fam_t5: 'fifty',
      fam_t6: 'sixty',
      fam_num_tu: '{t}-{u}',
      fam_gate_first_intro: 'Before the first parent PIN, please answer this question for grown-ups.',
      fam_pin_reset_notice: 'The PIN was reset on {date}. If it was not you, please choose a new PIN in Settings.',
      fam_dismiss: 'Hide this',
      fam_parent_autolock: 'It stays open while you use it, and locks after 3 minutes without use, when the app is left, or with “Close the parent area”.',
      fam_parent_title: 'Parent area',
      fam_parent_help: 'Praise and surprises keep children wanting to learn; rewards work best for effort the child can see.',
      fam_parent_sections: 'Sections of the parent area',
      fam_sec_tasks: 'Tasks',
      fam_sec_rewards: 'Rewards',
      fam_sec_children: 'Children',
      fam_sec_settings: 'Settings',
      fam_parent_close: 'Close the parent area',
      // What of the family's data reaches the server, true in every mode: the fields that
      // web/app.js sends (api/recite/check, api/dictation/check, api/text/check, api/tts;
      // api/quran/check sends numbers) and what backend/mommy/app.py logs.
      fam_privacy_line: 'Your family’s list (children, their texts, tasks, stars, rewards and the PIN) is saved only in this browser, on this device, unless a copy is saved with “Save a copy”: the copy is a file, without the PIN, where the browser saves downloads. To check a text or read it out, the Mommy server gets the text and its language, and for a recitation or dictation check also the child’s age group; a Quran check sends the surah and ayat numbers instead. The server does not keep the texts or the age group; its log notes the language, the kind of check and the ayat numbers.',
      fam_tasks_of: 'Child',
      fam_tasks_nochild: 'Please add a child first, in the section “Children”.',
      fam_tasks_empty: 'No task yet.',
      fam_tasks_archived: 'Archived tasks: {n}',
      fam_task_new: 'New task',
      fam_task_edit_title: 'Edit the task',
      fam_edit: 'Edit',
      fam_archive: 'Archive',
      fam_task_archived: 'The task was archived.',
      fam_task_saved: 'The task was saved.',
      fam_task_saved_quran: 'The task was saved. Its text has words of the Quran: they are checked word by word, and in a dictation a grown-up reads them aloud.',
      fam_status_assigned: 'To do',
      fam_status_done: 'Done',
      fam_tf_kind: 'Kind of task',
      fam_tf_title: 'Title (optional)',
      fam_tf_title_ph: 'The first words of the text',
      fam_tf_text: 'Text',
      fam_tf_qmode: 'How the child recites',
      fam_tf_quran_note: 'A Quran task is always checked word by word, against the verbatim Tanzil text.',
      fam_tf_pass: 'Pass level',
      fam_tf_pass_meaning: 'With “The meaning”, the task passes when the meaning is the same, with no idea missing.',
      fam_tf_stars: 'Stars',
      fam_tf_due: 'Due date (optional)',
      fam_tf_reward: 'Reward (optional)',
      fam_tf_reward_text: 'The reward',
      fam_tf_reward_ph: 'e.g. an ice cream',
      fam_tf_reward_emoji: 'Picture of the reward',
      fam_save: 'Save',
      fam_err_quran_task: 'This text is from the Quran. Please create a task of the kind “Quran” instead.',
      fam_err_quran_meaning_task: 'This text has words of the Quran, and the app never judges the meaning of the Quran, so “The meaning” is not available for it. “Word by word” is now chosen: please check the task and save it again.',
      fam_err_quran_unmarked_task: 'This text cannot be a dictation task: the voice found words of the Quran in it that the app could not mark for a grown-up to read. It can be a recite task, word by word.',
      fam_err_quran_diff_task: 'Some words of the Quran in this text are not as in the mushaf: see the note under the text. Please use the mushaf text, or press “Save” again to keep the text as it is.',
      fam_make_quran_task: 'Create a Quran task with these ayat',
      fam_err_offline: 'The text could not be checked: the server cannot be reached. The form is kept; please try again when the server is back.',
      fam_err_quran_range: 'Please choose valid ayat: at most 50, inside the surah.',
      fam_err_due: 'Please choose a valid date.',
      fam_page_has_quran: 'This page seems to be ayat of the Quran only. Please create a task of the kind “Quran” for them.',
      fam_child_add: 'Add a child',
      fam_child_new_title: 'New child',
      fam_child_edit_title: 'Edit the profile',
      fam_remove: 'Remove',
      fam_child_remove_q: 'Remove the profile of {name}? All the tasks, stars and rewards of this profile on this device are deleted too. This cannot be undone.',
      fam_child_removed: 'The profile was removed, with all its data.',
      fam_child_saved: 'Saved.',
      fam_quran_title: '{name} {from}–{to}',
      fam_review_best: 'Best: {pct}',
      fam_review_last: 'Last: {pct}',
      fam_review_attempts: 'Tries: {n}',
      fam_review_passed: 'Passed: {n}',
      fam_review_improve: '{n} more words right in the last try than before.',
      fam_review_improve_one: '{n} more word right in the last try than before.',
      fam_res_same_meaning: 'same meaning',
      fam_res_partly: 'partly the same meaning',
      fam_res_different: 'another meaning',
      fam_res_unclear: 'not clear',
      fam_confirm_anyway: 'Confirm anyway',
      fam_confirmed_for: 'Done: {stars} for {name}.',
      fam_reward_to_give: 'The reward {reward} is earned. Once it is given, please mark it under “Rewards”.',
      fam_details: 'Details',
      fam_detail_created: 'Created: {date}',
      fam_detail_due: 'Due: {date}',
      fam_detail_done: 'Done: {date}',
      fam_detail_by_app: 'Passed in the app: the stars were given at once.',
      fam_detail_by_parent: 'Marked as done by a grown-up.',
      fam_detail_sent_back: 'Sent back: {date}',
      fam_detail_no_try: 'No try yet.',
      fam_detail_quran: 'Ayat {from}–{to}',
      fam_detail_mode: 'Reciting mode: {mode}',
      fam_detail_anyway_hint: 'The app has not passed this task. If you heard your child do it, you can confirm it anyway.',
      fam_detail_anyway_again: 'This task is to do again. If you heard your child do it, you can confirm it anyway.',
      fam_rs_locked: 'The reward unlocks when the task is done.',
      fam_rs_unlocked: 'The reward is unlocked and waits to be given.',
      fam_rs_given: 'The reward was given.',
      fam_mark_given: 'Mark as given',
      fam_marked_given: 'Marked as given: {reward}.',
      fam_rw_earned: 'Earned in all: {n}',
      fam_rw_to_give_h: 'Rewards to give',
      fam_rw_to_give_empty: 'No reward is waiting to be given.',
      fam_rw_for_task: 'For the task: {title}',
      fam_goals_h: 'Goals of the star jar',
      fam_goals_empty: 'No goal yet. A goal is a reward the child saves stars for.',
      fam_goal_cost: 'Stars needed: {n}',
      fam_goal_enough: 'Enough stars!',
      fam_goal_short: 'Still needed: {n}',
      fam_goal_give: 'Give',
      fam_goal_given_on: 'Given: {date}',
      fam_goal_add: 'Add a goal',
      fam_goal_new: 'New goal',
      fam_goal_cost_label: 'Stars needed (1 to 500)',
      fam_goal_added: 'The goal was added.',
      fam_goal_removed: 'The goal was removed.',
      fam_goal_given_now: 'Given: {reward}. Stars in the jar: {n}.',
      fam_err_cost: 'Please type a number of stars from 1 to 500.',
      fam_err_reward_text: 'Please type the reward.',
      fam_err_not_enough: 'There are not enough stars in the jar for this goal yet.',
      fam_surprise_h: 'Give a surprise',
      fam_surprise_about: 'A surprise can come at any time, not only after a task. The child sees it once, on their home screen.',
      fam_surprise_text: 'The surprise',
      fam_surprise_ph: 'e.g. a picnic in the park',
      fam_surprise_give: 'Give the surprise',
      fam_surprise_done: 'The surprise is ready: {name} sees it on the home screen.',
      fam_surprise_unseen: 'Not seen yet: {list}',
      fam_err_surprise_text: 'Please type the surprise.',
      fam_adjust_h: 'Adjust stars',
      fam_adjust_about: 'For a correction: stars are never taken away for a try that did not work, and the jar never goes below zero. The stars of a task can also be taken back in the history below.',
      fam_adjust_way: 'Correction',
      fam_adjust_add: 'Add stars',
      fam_adjust_take: 'Take stars away',
      fam_adjust_n: 'Number of stars (1 to 500)',
      fam_adjust_note: 'Reason',
      fam_adjust_note_ph: 'e.g. a task done on paper',
      fam_adjust_done: 'Saved. Stars in the jar: {n}.',
      fam_adjust_limited: 'Only the stars in the jar were taken away: it is at zero now.',
      fam_err_note: 'Please type a reason.',
      fam_err_no_stars: 'There are no stars to take away.',
      fam_history_h: 'History of the stars',
      fam_history_empty: 'No stars yet.',
      fam_led_task: 'Task: {title}',
      fam_led_task_gone: 'A task',
      fam_led_goal: 'Goal given: {reward}',
      fam_led_goal_gone: 'A goal given',
      fam_led_adjust: 'Correction: {note}',
      fam_led_adjust_plain: 'Correction',
      fam_led_carry: 'Earlier stars, added together',
      fam_show_all: 'Show all ({n})',
      fam_show_less: 'Show fewer',
      fam_pin_change: 'Change the PIN',
      fam_pin_change_title: 'Change the PIN',
      fam_pin_change_intro: 'Please type the current PIN first.',
      fam_pin_change_new: 'Please choose the new PIN (4 to 6 digits) and type it twice.',
      fam_pin_changed: 'The PIN was changed.',
      fam_continue: 'Continue',
      fam_set_lang_h: 'Language of the parent area',
      fam_set_lang_hint: 'For the parent area and the PIN. Each child keeps their own language (in “Children”).',
      fam_set_lang_saved: 'Saved.',
      fam_set_delete_h: 'Delete all data on this device',
      fam_set_delete_about: 'Deletes every child, task, star and reward, the PIN and the settings, on this device only (not a copy saved as a file). The app then starts again as on the first day.',
      fam_delete: 'Delete all data',
      fam_delete_q1: 'Delete all the family data on this device? This cannot be undone.',
      fam_delete_q2: 'Last check: every child, task, star and reward, and the PIN, will be deleted.',
      fam_delete_final: 'Delete everything',
      fam_delete_failed: 'The data could not be deleted: this browser does not allow it right now.',
      fam_notice_deleted: 'All the family data on this device was deleted.',
      fam_copy_h: 'A copy of the family list',
      fam_copy_about: 'The family list is saved in this browser, for this web address only. If Mommy moves to a new address (a new link), the list is empty there: please save a copy here beforehand, then load it at the new address. A copy can also move the list to another device.',
      fam_copy_save: 'Save a copy',
      fam_copy_load: 'Load a copy',
      fam_copy_note: 'The file holds the children’s names and age groups, their texts, tasks, stars and rewards, but not the PIN. It is not encrypted: please keep it private.',
      fam_copy_saved: 'The browser saves the copy as {name}, usually in the Downloads folder.',
      fam_copy_summary_title: 'In this copy, saved on {date}:',
      fam_copy_summary_title_nodate: 'In this copy:',
      fam_copy_children: 'Children: {n}',
      fam_copy_child_line: '{name} — tasks: {tasks}, stars: {stars}',
      fam_copy_repaired: 'Part of this copy was damaged: it has been repaired as far as possible.',
      fam_copy_replace_q: 'Replace this device’s family list with the copy? The children, tasks, stars and rewards here are replaced; the PIN and the consents of this device stay as they are.',
      fam_copy_save_first: 'To keep the current list too, please press “Save a copy” first.',
      fam_copy_replace: 'Replace',
      fam_copy_loaded: 'Done: this device now uses the family list of the copy.',
      fam_copy_setup_hint: 'Do you have a copy of your family list from another address or device? Load it here: its children, tasks, stars and rewards are then used instead of a first child.',
      fam_copy_setup_using: 'The children, tasks, stars and rewards of this copy will be used. The consents and the PIN are not in the copy: they are asked here, as for a new family.',
      fam_copy_drop: 'Do not use this copy',
      fam_copy_err_not_copy: 'This file is not a copy of a Mommy family list.',
      fam_copy_err_damaged: 'This copy is damaged and cannot be used.',
      fam_copy_err_too_big: 'This file is too big to be a copy of a Mommy family list (more than 2 MB).',
      fam_copy_err_newer: 'This copy was saved by a newer version of Mommy, which this version cannot read.',
      fam_copy_err_read: 'The file could not be read. Please try again.',
      fam_copy_err_save_big: 'The family list is too big to be saved as a copy (more than 2 MB).',
      fam_copy_err_save: 'The copy could not be saved in this browser.',
      fam_copy_err_empty: 'This copy holds no children, so there is nothing in it to use.',
      fam_copy_err_save_empty: 'There is no child in the family list yet, so there is nothing to save.',
      fam_copy_err_full: 'The storage of this browser is full, so the copy could not be used. Please free some space (for example old site data), then try again.',
    },

    fr: {
      fam_tf_text_empty: 'Tapez ou collez d’abord un texte.',
      fam_more_setup: 'Plus : confidentialité, copie de la liste de la famille',
      fam_led_practice_gone: 'Entraînement',
      fam_led_practice_quran: 'Entraînement : Coran',
      fam_led_practice: 'Entraînement : {title}',
      fam_led_undo_gone: 'Étoiles reprises',
      fam_led_undo: 'Reprises : {title}',
      fam_undone: 'Les étoiles ont été reprises : la tâche est de nouveau à faire.',
      fam_undo_q: 'Reprendre les étoiles de cette tâche ? Elle revient dans « À faire », et sa récompense est de nouveau verrouillée.',
      fam_undo: 'Reprendre les étoiles',
      fam_mark_done_hint: 'Si l’application a mal entendu et que vous avez vu votre enfant le faire, vous pouvez le marquer comme fait : ses étoiles vont dans le bocal.',
      fam_mark_done: 'Marquer comme fait',
      fam_tf_more: 'Plus d’options (titre, niveau de réussite, récompense, date)',
      fam_tasks_about: 'Facultatif : des suggestions pour un enfant. L’application donne les étoiles quand l’enfant réussit ; les enfants peuvent toujours s’entraîner librement aussi.',
      texts_mode_words: 'mot à mot',
      texts_mode_meaning: 'par le sens',
      texts_deleted: 'Le texte a été supprimé.',
      texts_delete_q: 'Supprimer ce texte ? Ses étoiles sont gardées dans le bocal.',
      texts_delete: 'Supprimer',
      texts_edit: 'Modifier',
      texts_dict: 'Dictée',
      texts_read: 'Lire',
      texts_full: 'Il y a déjà {n} textes. Supprimons-en un d’abord.',
      texts_empty: 'Pas encore de texte. Appuyons sur « Nouveau texte » pour en ajouter un.',
      texts_new: 'Nouveau texte',
      texts_lead: 'Enregistrons un texte une fois, puis lisons-le à voix haute ou écrivons-le en dictée, aussi souvent que nous voulons.',
      texts_title: 'Mes textes',
      fam_practice_limit: 'Bravo ! Les étoiles d’entraînement du jour sont toutes gagnées : d’autres demain.',
      fam_practice_again: 'Bravo ! L’étoile de cet exercice est déjà gagnée aujourd’hui.',
      fam_practice_star: 'Bravo ! Une étoile pour le bocal : ⭐',
      fam_wa_err_name: 'Tapons d’abord un prénom.',
      fam_wa_save: 'Ajouter',
      fam_wa_lang: 'Langue',
      fam_wa_name: 'Prénom',
      fam_who_add_title: 'Un nouveau profil',
      fam_who_add: 'Ajouter mon profil',
      fam_more: 'Plus',
      fam_privacy_short: 'La liste de la famille (enfants, textes, étoiles, récompenses et code parent) reste dans ce navigateur, sur cet appareil.',
      fam_setup_more_children: 'D’autres enfants pourront s’ajouter eux-mêmes ensuite, sur « Qui apprend aujourd’hui ? ».',
      fam_task_word_by_word: 'La tâche se récite maintenant mot à mot.',
      fam_make_word_by_word: 'Réciter mot à mot',
      fam_detail_meaning_quran: 'Cette tâche se fait par le sens, mais son texte contient des mots du Coran, qui se récitent seulement mot à mot : l’enfant ne peut pas la faire telle quelle.',
      fam_keep: 'Garder',
      fam_goal_remove_q: 'Retirer cet objectif ? Les étoiles du bocal ne changent pas.',
      fam_archive_q: 'Archiver cette tâche ? Elle quitte les listes et ne peut pas revenir.',
      fam_improve_many: '{n} mots justes de plus que la dernière fois !',
      fam_improve_few: '{n} mots justes de plus que la dernière fois !',
      fam_improve_two: '{n} mots justes de plus que la dernière fois !',
      fam_detail_anyway_dictation: 'La feuille est vérifiée dans « La vérification de maman » à la fin de la dictée. Si vous avez vérifié la feuille vous-même une autre fois et qu’elle est juste, vous pouvez marquer la tâche comme faite.',
      fam_err_quran_meaning_diff: 'Ce texte contient des mots du Coran, qui se récitent seulement mot à mot : « Mot à mot » est maintenant choisi. Certains ne sont pas comme dans le mushaf (voir la note sous le texte). Prenez le texte du mushaf avant d’enregistrer.',
      fam_err_quran_diff_recite: 'Des mots du Coran de ce texte ne sont pas comme dans le mushaf : voir la note sous le texte. Prenez le texte du mushaf avant d’enregistrer.',
      fam_setup_lead: 'Une seule fois, pour toute la famille : cela prend une minute.',
      fam_setup_title: 'Préparer la famille',
      fam_parent_lang: 'Langue pour les adultes',
      fam_pin_legend: 'Code parent',
      fam_pin_about: 'Le code est un verrou parental : il réserve l’espace parents aux adultes. Il a de 4 à 6 chiffres.',
      fam_pin_new: 'Nouveau code',
      fam_pin_again: 'Le même code une deuxième fois',
      fam_first_child: 'Le premier enfant',
      fam_child_lang: 'Langue de l’enfant',
      fam_avatar: 'Image',
      fam_err_nickname: 'Tapez un surnom.',
      fam_err_pin_format: 'Un code a de 4 à 6 chiffres.',
      fam_err_pin_same: 'Les deux codes ne sont pas pareils. Tapez-les de nouveau.',
      fam_err_crypto: 'Le code ne peut pas être utilisé sur cette page : il faut https ou localhost.',
      fam_saving: 'Enregistrement…',
      fam_ok: 'OK',
      fam_notice_corrupt: 'Les données de la famille enregistrées sur cet appareil n’ont pas pu être lues. Elles ont été mises de côté sur cet appareil, et tout recommence.',
      fam_notice_repaired: 'Une partie des données de la famille sur cet appareil était abîmée et a été réparée. Une copie des anciennes données a été gardée sur cet appareil.',
      fam_notice_quota: 'Le stockage de ce navigateur est plein : la dernière modification n’a pas pu être enregistrée. Libérez de la place (par exemple d’anciennes données de sites), puis réessayez.',
      fam_notice_memory: 'Ce navigateur ne permet pas d’enregistrer ici (navigation privée ?). Tout fonctionne jusqu’à la fermeture de la page, puis les données sont perdues.',
      fam_who_title: 'Qui apprend aujourd’hui ?',
      fam_who_empty: 'Personne pour l’instant : ajoutons le premier profil.',
      fam_for_parents: 'Pour les parents',
      fam_jar: 'Étoiles dans le bocal : {n}',
      fam_goal_missing: 'Encore {n} étoiles pour : {reward}',
      fam_goal_missing_one: 'Encore {n} étoile pour : {reward}',
      fam_goal_reached: 'Assez d’étoiles pour : {reward} ! Parles-en à ton parent.',
      fam_todo: 'Proposé par les parents',
      fam_done: 'Mes trophées',
      fam_free: 'S’entraîner',
      fam_switch_child: 'Changer d’enfant',
      fam_kind_recite: 'Réciter',
      fam_kind_dictation: 'Dictée',
      fam_kind_quran: 'Coran',
      fam_stars_n: 'Étoiles : {n}',
      fam_due: 'Pour le {date}',
      fam_reward_label: 'Récompense :',
      fam_note_label: 'Note :',
      fam_start: 'Commencer',
      fam_pass_all_words: 'Tous les mots justes',
      fam_pass_nine_in_ten: '9 mots sur 10',
      fam_pass_eight_in_ten: '8 mots sur 10',
      fam_pass_same_meaning: 'Même sens',
      fam_pass_line: 'Pour réussir : {rule}',
      fam_reward_unlocked: 'Gagné ! Un parent la donnera.',
      fam_reward_given: 'Reçue',
      fam_surprise_title: 'Une surprise pour toi !',
      fam_surprise_ok: 'Merci !',
      fam_task_banner_label: 'Tâche',
      fam_task_leave: 'Retour à l’accueil',
      fam_celebrate: 'Bravo ! {stars} sont dans le bocal.',
      fam_celebrate_reward: 'Bravo ! {stars} sont dans le bocal, et {reward} est gagné : un parent le donnera.',
      fam_improve: '{n} mots justes de plus que la dernière fois !',
      fam_improve_one: '{n} mot juste de plus que la dernière fois !',
      fam_try_again: 'Tu peux réessayer quand tu veux.',
      fam_pin_enter_title: 'Espace parents',
      fam_pin_enter_intro: 'Tapez le code parent. C’est un verrou contre les enfants : il garde cet espace pour les adultes.',
      fam_pin_label: 'Code',
      fam_pin_create_title: 'Créer le code parent',
      fam_pin_create_intro: 'Choisissez un code de 4 à 6 chiffres et tapez-le deux fois. C’est un verrou contre les enfants : il garde l’espace parents pour les adultes.',
      fam_pin_reset_intro: 'Toutes les données sont gardées. Choisissez un nouveau code et tapez-le deux fois ; l’ancien code marche jusqu’à ce que le nouveau soit enregistré.',
      fam_unlock: 'Ouvrir',
      fam_confirm: 'Valider',
      fam_create: 'Créer',
      fam_cancel: 'Annuler',
      fam_forgot: 'Code oublié ?',
      fam_pin_wrong: 'Code faux. Essais restants avant une pause : {n}.',
      fam_pin_wrong_last: 'Code faux.',
      fam_pin_locked: 'Trop d’essais. Attendez {time} avant de réessayer.',
      fam_pin_checking: 'Vérification…',
      fam_gate_title: 'Code oublié',
      fam_gate_intro: 'Pour créer un nouveau code, répondez à cette question pour les adultes. Toutes les données sont gardées.',
      fam_gate_q: 'Combien font {a} fois {b} ? Tapez la réponse en chiffres.',
      fam_gate_wrong: 'Ce n’est pas la bonne réponse. Voici une autre question.',
      fam_gate_check: 'Vérifier',
      fam_n3: 'trois',
      fam_n4: 'quatre',
      fam_n5: 'cinq',
      fam_n6: 'six',
      fam_n7: 'sept',
      fam_n8: 'huit',
      fam_n9: 'neuf',
      fam_t2: 'vingt',
      fam_t3: 'trente',
      fam_t4: 'quarante',
      fam_t5: 'cinquante',
      fam_t6: 'soixante',
      fam_num_tu: '{t}-{u}',
      fam_gate_first_intro: 'Avant le premier code parent, répondez à cette question pour les adultes.',
      fam_pin_reset_notice: 'Le code a été réinitialisé le {date}. Si ce n’était pas vous, choisissez un nouveau code dans Réglages.',
      fam_dismiss: 'Masquer',
      fam_parent_autolock: 'Il reste ouvert pendant que vous l’utilisez, et se verrouille après 3 minutes sans utilisation, quand l’application est quittée, ou avec « Fermer l’espace parents ».',
      fam_parent_title: 'Espace parents',
      fam_parent_help: 'Les compliments et les surprises donnent envie d’apprendre ; les récompenses marchent le mieux pour un effort que l’enfant peut voir.',
      fam_parent_sections: 'Rubriques de l’espace parents',
      fam_sec_tasks: 'Tâches',
      fam_sec_rewards: 'Récompenses',
      fam_sec_children: 'Enfants',
      fam_sec_settings: 'Réglages',
      fam_parent_close: 'Fermer l’espace parents',
      fam_privacy_line: 'La liste de votre famille (enfants, leurs textes, tâches, étoiles, récompenses et code parent) est enregistrée uniquement dans ce navigateur, sur cet appareil, sauf si une copie est enregistrée avec « Enregistrer une copie » : la copie est alors un fichier, sans le code parent, là où le navigateur enregistre les téléchargements. Pour vérifier un texte ou le lire à voix haute, le serveur Mommy reçoit le texte et sa langue, et pour vérifier une récitation ou une dictée, aussi la tranche d’âge de l’enfant ; une vérification du Coran envoie à la place le numéro de la sourate et ceux des versets. Le serveur ne conserve ni les textes ni la tranche d’âge ; son journal note la langue, le type de vérification et les numéros des versets.',
      fam_tasks_of: 'Enfant',
      fam_tasks_nochild: 'Ajoutez d’abord un enfant, dans la rubrique « Enfants ».',
      fam_tasks_empty: 'Pas encore de tâche.',
      fam_tasks_archived: 'Tâches archivées : {n}',
      fam_task_new: 'Nouvelle tâche',
      fam_task_edit_title: 'Modifier la tâche',
      fam_edit: 'Modifier',
      fam_archive: 'Archiver',
      fam_task_archived: 'La tâche a été archivée.',
      fam_task_saved: 'La tâche a été enregistrée.',
      fam_task_saved_quran: 'La tâche a été enregistrée. Son texte contient des mots du Coran : ils sont vérifiés mot à mot, et dans une dictée un adulte les lit à voix haute.',
      fam_status_assigned: 'À faire',
      fam_status_done: 'Terminée',
      fam_tf_kind: 'Type de tâche',
      fam_tf_title: 'Titre (facultatif)',
      fam_tf_title_ph: 'Les premiers mots du texte',
      fam_tf_text: 'Texte',
      fam_tf_qmode: 'Comment l’enfant récite',
      fam_tf_quran_note: 'Une tâche de Coran est toujours vérifiée mot à mot, avec le texte exact de Tanzil.',
      fam_tf_pass: 'Niveau de réussite',
      fam_tf_pass_meaning: 'Avec « Le sens », la tâche est réussie quand le sens est le même, sans idée oubliée.',
      fam_tf_stars: 'Étoiles',
      fam_tf_due: 'Pour le (facultatif)',
      fam_tf_reward: 'Récompense (facultative)',
      fam_tf_reward_text: 'La récompense',
      fam_tf_reward_ph: 'ex. une glace',
      fam_tf_reward_emoji: 'Image de la récompense',
      fam_save: 'Enregistrer',
      fam_err_quran_task: 'Ce texte vient du Coran. Créez plutôt une tâche de type « Coran ».',
      fam_err_quran_meaning_task: 'Ce texte contient des mots du Coran, et l’application ne juge jamais le sens du Coran : « Le sens » n’est donc pas possible. « Mot à mot » est maintenant choisi : vérifiez la tâche et enregistrez-la de nouveau.',
      fam_err_quran_unmarked_task: 'Ce texte ne peut pas servir à une tâche de dictée : la voix y a trouvé des mots du Coran que l’application n’a pas pu marquer pour qu’un adulte les lise. Il peut servir à une tâche de récitation mot à mot.',
      fam_err_quran_diff_task: 'Des mots du Coran de ce texte ne sont pas comme dans le mushaf : voir la note sous le texte. Prenez le texte du mushaf, ou appuyez de nouveau sur « Enregistrer » pour garder le texte tel quel.',
      fam_make_quran_task: 'Créer une tâche Coran avec ces âyât',
      fam_err_offline: 'Le texte n’a pas pu être vérifié : le serveur ne répond pas. Le formulaire est gardé ; réessayez quand le serveur sera revenu.',
      fam_err_quran_range: 'Choisissez des âyât valables : 50 au maximum, dans la sourate.',
      fam_err_due: 'Choisissez une date valable.',
      fam_page_has_quran: 'Cette page semble ne contenir que des âyât du Coran. Créez pour elles une tâche de type « Coran ».',
      fam_child_add: 'Ajouter un enfant',
      fam_child_new_title: 'Nouvel enfant',
      fam_child_edit_title: 'Modifier le profil',
      fam_remove: 'Supprimer',
      fam_child_remove_q: 'Supprimer le profil de {name} ? Toutes les tâches, étoiles et récompenses de ce profil sur cet appareil sont aussi effacées. C’est définitif.',
      fam_child_removed: 'Le profil a été supprimé, avec toutes ses données.',
      fam_child_saved: 'C’est enregistré.',
      fam_quran_title: '{name} {from}–{to}',
      fam_review_best: 'Meilleur : {pct}',
      fam_review_last: 'Dernier : {pct}',
      fam_review_attempts: 'Essais : {n}',
      fam_review_passed: 'Réussis : {n}',
      fam_review_improve: '{n} mots justes de plus au dernier essai qu’avant.',
      fam_review_improve_one: '{n} mot juste de plus au dernier essai qu’avant.',
      fam_res_same_meaning: 'même sens',
      fam_res_partly: 'sens en partie le même',
      fam_res_different: 'un autre sens',
      fam_res_unclear: 'pas clair',
      fam_confirm_anyway: 'Valider quand même',
      fam_confirmed_for: 'Fait : {stars} pour {name}.',
      fam_reward_to_give: 'La récompense {reward} est gagnée. Une fois donnée, veuillez la marquer dans « Récompenses ».',
      fam_details: 'Détails',
      fam_detail_created: 'Créée : {date}',
      fam_detail_due: 'Pour le : {date}',
      fam_detail_done: 'Terminée : {date}',
      fam_detail_by_app: 'Réussi dans l’application : les étoiles ont été données aussitôt.',
      fam_detail_by_parent: 'Marqué comme fait par un adulte.',
      fam_detail_sent_back: 'Renvoyée : {date}',
      fam_detail_no_try: 'Pas encore d’essai.',
      fam_detail_quran: 'Âyât {from}–{to}',
      fam_detail_mode: 'Mode de récitation : {mode}',
      fam_detail_anyway_hint: 'L’application n’a pas réussi cette tâche. Si vous avez entendu votre enfant la faire, vous pouvez la valider quand même.',
      fam_detail_anyway_again: 'Cette tâche est de nouveau à faire. Si vous avez entendu votre enfant la faire, vous pouvez la valider quand même.',
      fam_rs_locked: 'La récompense se débloque quand la tâche est faite.',
      fam_rs_unlocked: 'La récompense est débloquée et attend d’être donnée.',
      fam_rs_given: 'La récompense a été donnée.',
      fam_mark_given: 'Marquer comme donnée',
      fam_marked_given: 'Notée comme donnée : {reward}.',
      fam_rw_earned: 'Gagnées en tout : {n}',
      fam_rw_to_give_h: 'Récompenses à donner',
      fam_rw_to_give_empty: 'Aucune récompense n’attend d’être donnée.',
      fam_rw_for_task: 'Pour la tâche : {title}',
      fam_goals_h: 'Objectifs du bocal',
      fam_goals_empty: 'Pas encore d’objectif. Un objectif est une récompense pour laquelle l’enfant garde ses étoiles.',
      fam_goal_cost: 'Étoiles nécessaires : {n}',
      fam_goal_enough: 'Assez d’étoiles !',
      fam_goal_short: 'Il en manque : {n}',
      fam_goal_give: 'Donner',
      fam_goal_given_on: 'Donné : {date}',
      fam_goal_add: 'Ajouter un objectif',
      fam_goal_new: 'Nouvel objectif',
      fam_goal_cost_label: 'Étoiles nécessaires (de 1 à 500)',
      fam_goal_added: 'L’objectif a été ajouté.',
      fam_goal_removed: 'L’objectif a été supprimé.',
      fam_goal_given_now: 'Donné : {reward}. Étoiles dans le bocal : {n}.',
      fam_err_cost: 'Tapez un nombre d’étoiles de 1 à 500.',
      fam_err_reward_text: 'Tapez la récompense.',
      fam_err_not_enough: 'Il n’y a pas encore assez d’étoiles dans le bocal pour cet objectif.',
      fam_surprise_h: 'Faire une surprise',
      fam_surprise_about: 'Une surprise peut arriver à tout moment, pas seulement après une tâche. L’enfant la voit une fois, sur son écran d’accueil.',
      fam_surprise_text: 'La surprise',
      fam_surprise_ph: 'ex. un pique-nique au parc',
      fam_surprise_give: 'Offrir la surprise',
      fam_surprise_done: 'La surprise est prête : {name} la verra sur son écran d’accueil.',
      fam_surprise_unseen: 'Pas encore vue : {list}',
      fam_err_surprise_text: 'Tapez la surprise.',
      fam_adjust_h: 'Corriger les étoiles',
      fam_adjust_about: 'Pour une correction : on n’enlève jamais d’étoiles pour un essai qui n’a pas marché, et le bocal ne descend jamais sous zéro. Les étoiles d’une tâche peuvent aussi être reprises dans l’historique ci-dessous.',
      fam_adjust_way: 'Correction',
      fam_adjust_add: 'Ajouter des étoiles',
      fam_adjust_take: 'Retirer des étoiles',
      fam_adjust_n: 'Nombre d’étoiles (de 1 à 500)',
      fam_adjust_note: 'Raison',
      fam_adjust_note_ph: 'ex. une tâche faite sur papier',
      fam_adjust_done: 'C’est enregistré. Étoiles dans le bocal : {n}.',
      fam_adjust_limited: 'Seules les étoiles du bocal ont été retirées : il est à zéro.',
      fam_err_note: 'Tapez une raison.',
      fam_err_no_stars: 'Il n’y a pas d’étoile à retirer.',
      fam_history_h: 'Historique des étoiles',
      fam_history_empty: 'Pas encore d’étoile.',
      fam_led_task: 'Tâche : {title}',
      fam_led_task_gone: 'Une tâche',
      fam_led_goal: 'Objectif donné : {reward}',
      fam_led_goal_gone: 'Un objectif donné',
      fam_led_adjust: 'Correction : {note}',
      fam_led_adjust_plain: 'Correction',
      fam_led_carry: 'Étoiles plus anciennes, additionnées',
      fam_show_all: 'Tout afficher ({n})',
      fam_show_less: 'Afficher moins',
      fam_pin_change: 'Changer le code',
      fam_pin_change_title: 'Changer le code',
      fam_pin_change_intro: 'Tapez d’abord le code actuel.',
      fam_pin_change_new: 'Choisissez le nouveau code (de 4 à 6 chiffres) et tapez-le deux fois.',
      fam_pin_changed: 'Le code a été changé.',
      fam_continue: 'Continuer',
      fam_set_lang_h: 'Langue de l’espace parents',
      fam_set_lang_hint: 'Pour l’espace parents et le code. Chaque enfant garde sa propre langue (dans « Enfants »).',
      fam_set_lang_saved: 'C’est enregistré.',
      fam_set_delete_h: 'Effacer toutes les données de cet appareil',
      fam_set_delete_about: 'Efface tous les enfants, tâches, étoiles et récompenses, le code et les réglages, sur cet appareil seulement (pas une copie enregistrée dans un fichier). L’application recommence alors comme au premier jour.',
      fam_delete: 'Tout effacer',
      fam_delete_q1: 'Effacer toutes les données de la famille sur cet appareil ? C’est définitif.',
      fam_delete_q2: 'Dernière vérification : tous les enfants, tâches, étoiles et récompenses, et le code, seront effacés.',
      fam_delete_final: 'Tout effacer maintenant',
      fam_delete_failed: 'Les données n’ont pas pu être effacées : ce navigateur ne le permet pas pour l’instant.',
      fam_notice_deleted: 'Toutes les données de la famille sur cet appareil ont été effacées.',
      fam_copy_h: 'Une copie de la liste de la famille',
      fam_copy_about: 'La liste de la famille est enregistrée dans ce navigateur, pour cette adresse web seulement. Si Mommy change d’adresse (un nouveau lien), la liste y est vide : enregistrez une copie ici à l’avance, puis chargez-la à la nouvelle adresse. Une copie permet aussi de passer la liste sur un autre appareil.',
      fam_copy_save: 'Enregistrer une copie',
      fam_copy_load: 'Charger une copie',
      fam_copy_note: 'Le fichier contient les surnoms et les tranches d’âge des enfants, leurs textes, tâches, étoiles et récompenses, mais pas le code parent. Il n’est pas chiffré : gardez-le pour vous.',
      fam_copy_saved: 'Le navigateur enregistre la copie sous le nom {name}, en général dans le dossier Téléchargements.',
      fam_copy_summary_title: 'Dans cette copie, enregistrée le {date} :',
      fam_copy_summary_title_nodate: 'Dans cette copie :',
      fam_copy_children: 'Enfants : {n}',
      fam_copy_child_line: '{name} — tâches : {tasks}, étoiles : {stars}',
      fam_copy_repaired: 'Une partie de cette copie était abîmée : elle a été réparée autant que possible.',
      fam_copy_replace_q: 'Remplacer la liste de la famille de cet appareil par la copie ? Les enfants, les tâches, les étoiles et les récompenses d’ici sont remplacés ; le code parent et les consentements de cet appareil restent tels quels.',
      fam_copy_save_first: 'Pour garder aussi la liste actuelle, appuyez d’abord sur « Enregistrer une copie ».',
      fam_copy_replace: 'Remplacer',
      fam_copy_loaded: 'C’est fait : cet appareil utilise maintenant la liste de la famille de la copie.',
      fam_copy_setup_hint: 'Vous avez une copie de la liste de votre famille, venue d’une autre adresse ou d’un autre appareil ? Chargez-la ici : ses enfants, tâches, étoiles et récompenses sont alors utilisés à la place d’un premier enfant.',
      fam_copy_setup_using: 'Les enfants, les tâches, les étoiles et les récompenses de cette copie seront utilisés. Les consentements et le code parent ne sont pas dans la copie : ils sont demandés ici, comme pour une nouvelle famille.',
      fam_copy_drop: 'Ne pas utiliser cette copie',
      fam_copy_err_not_copy: 'Ce fichier n’est pas une copie d’une liste de famille de Mommy.',
      fam_copy_err_damaged: 'Cette copie est abîmée et ne peut pas être utilisée.',
      fam_copy_err_too_big: 'Ce fichier est trop gros pour être une copie d’une liste de famille de Mommy (plus de 2 Mo).',
      fam_copy_err_newer: 'Cette copie a été enregistrée par une version plus récente de Mommy, que cette version ne sait pas lire.',
      fam_copy_err_read: 'Le fichier n’a pas pu être lu. Veuillez réessayer.',
      fam_copy_err_save_big: 'La liste de la famille est trop grosse pour être enregistrée dans une copie (plus de 2 Mo).',
      fam_copy_err_save: 'La copie n’a pas pu être enregistrée dans ce navigateur.',
      fam_copy_err_empty: 'Cette copie ne contient aucun enfant, il n’y a donc rien à utiliser.',
      fam_copy_err_save_empty: 'La liste de la famille ne contient encore aucun enfant, il n’y a donc rien à enregistrer.',
      fam_copy_err_full: 'Le stockage de ce navigateur est plein : la copie n’a pas pu être utilisée. Libérez de la place (par exemple d’anciennes données de sites), puis réessayez.',
    },

    ar: {
      fam_tf_text_empty: 'يُرجى كتابة نص أو لصقه أولًا.',
      fam_more_setup: 'المزيد: الخصوصية، نسخة من قائمة العائلة',
      fam_led_practice_gone: 'تدرّب',
      fam_led_practice_quran: 'تدرّب: القرآن الكريم',
      fam_led_practice: 'تدرّب: {title}',
      fam_led_undo_gone: 'استرجاع نجوم',
      fam_led_undo: 'استرجاع: {title}',
      fam_undone: 'استُرجعت النجوم، وعادت المهمة مطلوبة.',
      fam_undo_q: 'استرجاع نجوم هذه المهمة؟ تعود إلى «مطلوبة»، وتُقفَل مكافأتها من جديد.',
      fam_undo: 'استرجاع النجوم',
      fam_mark_done_hint: 'إذا أخطأ التطبيق في السماع وكان الإنجاز واضحًا، فيمكن تسجيله، فتُضاف نجومه إلى الجرّة.',
      fam_mark_done: 'تسجيل الإنجاز',
      fam_tf_more: 'خيارات أخرى (العنوان، مستوى النجاح، المكافأة، الموعد)',
      fam_tasks_about: 'اختياري: اقتراحات لطفل. يمنح التطبيق النجوم عند الإنجاز، ويمكن للأطفال دائمًا التدرّب بحرّية أيضًا.',
      texts_mode_words: 'كلمةً بكلمة',
      texts_mode_meaning: 'بالمعنى',
      texts_deleted: 'حُذف النص.',
      texts_delete_q: 'حذف هذا النص؟ تبقى نجومه في الجرّة.',
      texts_delete: 'حذف',
      texts_edit: 'تعديل',
      texts_dict: 'إملاء',
      texts_read: 'تسميع',
      texts_full: 'عدد النصوص: {n}، وهو الحد الأقصى. هيا نحذف نصًا أولًا.',
      texts_empty: 'لا يوجد نص بعد. هيا نضغط «نص جديد» لإضافة نص.',
      texts_new: 'نص جديد',
      texts_lead: 'هيا نحفظ النص مرة واحدة، ثم نقرؤه بصوت عالٍ أو نكتبه إملاءً كلما أردنا.',
      texts_title: 'نصوصي',
      fam_practice_limit: 'أحسنت! كُسبت كل نجوم التدرّب لهذا اليوم، وغدًا نجوم أخرى.',
      fam_practice_again: 'أحسنت! كُسبت نجمة هذا التمرين اليوم.',
      fam_practice_star: 'أحسنت! نجمة للجرّة: ⭐',
      fam_wa_err_name: 'هيا نكتب الاسم أولًا.',
      fam_wa_save: 'إضافة',
      fam_wa_lang: 'اللغة',
      fam_wa_name: 'الاسم',
      fam_who_add_title: 'ملف جديد',
      fam_who_add: 'إضافة ملفي',
      fam_more: 'المزيد',
      fam_privacy_short: 'تبقى قائمة العائلة (الأطفال والنصوص والنجوم والمكافآت ورمز الكبار) في هذا المتصفح على هذا الجهاز.',
      fam_setup_more_children: 'يمكن لأطفال آخرين إضافة أنفسهم لاحقًا في «مَن معنا اليوم؟».',
      fam_task_word_by_word: 'صارت المهمة تُسمَّع كلمةً بكلمة.',
      fam_make_word_by_word: 'التسميع كلمةً بكلمة',
      fam_detail_meaning_quran: 'هذه المهمة بالمعنى، لكن في نصها كلمات من القرآن الكريم تُسمَّع كلمةً بكلمة فقط، فلا يمكن للطفل إنجازها كما هي.',
      fam_keep: 'إبقاء',
      fam_goal_remove_q: 'حذف هذا الهدف؟ تبقى النجوم في الجرّة كما هي.',
      fam_archive_q: 'أرشفة هذه المهمة؟ تخرج من القوائم، ولا يمكن إرجاعها.',
      fam_improve_many: '{n} كلمة صحيحة أكثر من المرة السابقة!',
      fam_improve_few: '{n} كلمات صحيحة أكثر من المرة السابقة!',
      fam_improve_two: 'كلمتان صحيحتان أكثر من المرة السابقة!',
      fam_detail_anyway_dictation: 'تُصحَّح الورقة في «تصحيح ماما» في نهاية الإملاء. وإذا صُحّحت الورقة في وقت آخر وكانت صحيحة، فيمكن تسجيل إنجاز المهمة.',
      fam_err_quran_meaning_diff: 'في هذا النص كلمات من القرآن الكريم، وهي تُسمَّع كلمةً بكلمة فقط، وقد اختيرت «كلمة بكلمة». وبعضها ليس كما في المصحف، كما هو مبيَّن تحت النص. يُرجى استخدام نص المصحف قبل الحفظ.',
      fam_err_quran_diff_recite: 'بعض كلمات القرآن الكريم في هذا النص ليست كما في المصحف، كما هو مبيَّن تحت النص. يُرجى استخدام نص المصحف قبل الحفظ.',
      fam_setup_lead: 'إعداد لمرة واحدة للعائلة كلها، ويستغرق دقيقة.',
      fam_setup_title: 'إعداد العائلة',
      fam_parent_lang: 'لغة الكبار',
      fam_pin_legend: 'رمز الكبار',
      fam_pin_about: 'هذا الرمز قفل للأطفال: يُبقي قسم الكبار للكبار. يتكوّن من ٤ إلى ٦ أرقام.',
      fam_pin_new: 'الرمز الجديد',
      fam_pin_again: 'الرمز نفسه مرة أخرى',
      fam_first_child: 'الطفل الأول',
      fam_child_lang: 'لغة الطفل',
      fam_avatar: 'الصورة',
      fam_err_nickname: 'يُرجى كتابة اسم مستعار.',
      fam_err_pin_format: 'يتكوّن الرمز من ٤ إلى ٦ أرقام.',
      fam_err_pin_same: 'الرمزان غير متطابقين. يُرجى كتابتهما مرة أخرى.',
      fam_err_crypto: 'لا يمكن استخدام الرمز في هذه الصفحة: تحتاج إلى https أو localhost.',
      fam_saving: 'جارٍ الحفظ…',
      fam_ok: 'حسنًا',
      fam_notice_corrupt: 'تعذّرت قراءة بيانات العائلة المحفوظة على هذا الجهاز. حُفظت نسخة منها جانبًا على هذا الجهاز، وبدأ الإعداد من جديد.',
      fam_notice_repaired: 'كان جزء من بيانات العائلة على هذا الجهاز تالفًا وتمّ إصلاحه. حُفظت نسخة من البيانات القديمة على هذا الجهاز.',
      fam_notice_quota: 'مساحة التخزين في هذا المتصفح ممتلئة، فتعذّر حفظ التغيير الأخير. يُرجى إفراغ بعض المساحة (مثل بيانات مواقع قديمة) ثم المحاولة مرة أخرى.',
      fam_notice_memory: 'لا يسمح هذا المتصفح بالحفظ هنا (وضع التصفح الخاص؟). يعمل كل شيء حتى إغلاق الصفحة، ثم تضيع البيانات.',
      fam_who_title: 'مَن معنا اليوم؟',
      fam_who_empty: 'لا أحد هنا بعد: هيا نضيف الملف الأول.',
      fam_for_parents: 'للكبار',
      fam_jar: 'النجوم في الجرّة: {n}',
      fam_goal_missing: 'النجوم الباقية حتى {reward}: {n}',
      fam_goal_missing_one: 'النجوم الباقية حتى {reward}: {n}',
      fam_goal_reached: 'النجوم تكفي الآن لـ {reward}! هيا نخبر أحد الوالدين.',
      fam_todo: 'اقتراحات الوالدين',
      fam_done: 'إنجازاتي',
      fam_free: 'التدرّب',
      fam_switch_child: 'تغيير الطفل',
      fam_kind_recite: 'تسميع',
      fam_kind_dictation: 'إملاء',
      fam_kind_quran: 'القرآن الكريم',
      fam_stars_n: 'النجوم: {n}',
      fam_due: 'الموعد: {date}',
      fam_reward_label: 'المكافأة:',
      fam_note_label: 'ملاحظة:',
      fam_start: 'بدء',
      fam_pass_all_words: 'كل الكلمات صحيحة',
      fam_pass_nine_in_ten: '٩ كلمات من ١٠',
      fam_pass_eight_in_ten: '٨ كلمات من ١٠',
      fam_pass_same_meaning: 'المعنى نفسه',
      fam_pass_line: 'شرط النجاح: {rule}',
      fam_reward_unlocked: 'تمّ الفوز بها، وسيقدّمها أحد الوالدين.',
      fam_reward_given: 'تمّ استلامها',
      fam_surprise_title: 'مفاجأة جميلة!',
      fam_surprise_ok: 'شكرًا!',
      fam_task_banner_label: 'المهمة',
      fam_task_leave: 'العودة إلى الرئيسية',
      fam_celebrate: 'أحسنت! أُضيفت النجوم {stars} إلى الجرّة.',
      fam_celebrate_reward: 'أحسنت! أُضيفت النجوم {stars} إلى الجرّة، وتمّ الفوز بـ{reward}، وسيقدّمها أحد الوالدين.',
      fam_improve: '{n} كلمة صحيحة أكثر من المرة السابقة!',
      fam_improve_one: 'كلمة صحيحة واحدة أكثر من المرة السابقة!',
      fam_try_again: 'هيا نحاول مرة أخرى عندما نكون جاهزين.',
      fam_pin_enter_title: 'قسم الكبار',
      fam_pin_enter_intro: 'يُرجى كتابة رمز الكبار. هذا الرمز قفل للأطفال: يُبقي هذا القسم للكبار.',
      fam_pin_label: 'الرمز',
      fam_pin_create_title: 'إنشاء رمز الكبار',
      fam_pin_create_intro: 'يُرجى اختيار رمز من ٤ إلى ٦ أرقام وكتابته مرتين. هذا الرمز قفل للأطفال: يُبقي قسم الكبار للكبار.',
      fam_pin_reset_intro: 'تبقى البيانات كلها محفوظة. يُرجى اختيار رمز جديد وكتابته مرتين، ويبقى الرمز القديم صالحًا حتى حفظ الجديد.',
      fam_unlock: 'فتح',
      fam_confirm: 'تأكيد',
      fam_create: 'إنشاء',
      fam_cancel: 'إلغاء',
      fam_forgot: 'نسيان الرمز؟',
      fam_pin_wrong: 'الرمز غير صحيح. المحاولات الباقية قبل التوقف: {n}.',
      fam_pin_wrong_last: 'الرمز غير صحيح.',
      fam_pin_locked: 'محاولات كثيرة. يُرجى الانتظار {time} قبل المحاولة مرة أخرى.',
      fam_pin_checking: 'جارٍ التحقّق…',
      fam_gate_title: 'نسيان الرمز',
      fam_gate_intro: 'لإنشاء رمز جديد، يُرجى الإجابة عن هذا السؤال المخصّص للكبار. تبقى البيانات كلها محفوظة.',
      fam_gate_q: 'كم حاصل ضرب {a} في {b}؟ يُرجى كتابة الجواب بالأرقام.',
      fam_gate_wrong: 'هذا ليس الجواب الصحيح. هذا سؤال آخر.',
      fam_gate_check: 'التحقّق',
      fam_n3: 'ثلاثة',
      fam_n4: 'أربعة',
      fam_n5: 'خمسة',
      fam_n6: 'ستة',
      fam_n7: 'سبعة',
      fam_n8: 'ثمانية',
      fam_n9: 'تسعة',
      fam_t2: 'عشرين',
      fam_t3: 'ثلاثين',
      fam_t4: 'أربعين',
      fam_t5: 'خمسين',
      fam_t6: 'ستين',
      fam_num_tu: '{u} و{t}',
      fam_gate_first_intro: 'قبل إنشاء أول رمز للكبار، يُرجى الإجابة عن هذا السؤال المخصّص للكبار.',
      fam_pin_reset_notice: 'أُعيد تعيين الرمز في {date}. إذا لم تتم إعادة التعيين على يد أحد الكبار، يُرجى اختيار رمز جديد في «الإعدادات».',
      fam_dismiss: 'إخفاء',
      fam_parent_autolock: 'يبقى مفتوحًا أثناء استخدامه، ويُقفَل بعد ٣ دقائق دون استخدام، أو عند مغادرة التطبيق، أو بزرّ «إغلاق قسم الكبار».',
      fam_parent_title: 'قسم الكبار',
      fam_parent_help: 'المديح والمفاجآت تُبقي رغبة الأطفال في التعلّم، والمكافآت أنفع لجهد يراه الطفل بنفسه.',
      fam_parent_sections: 'أجزاء قسم الكبار',
      fam_sec_tasks: 'المهام',
      fam_sec_rewards: 'المكافآت',
      fam_sec_children: 'الأطفال',
      fam_sec_settings: 'الإعدادات',
      fam_parent_close: 'إغلاق قسم الكبار',
      fam_privacy_line: 'تُحفظ قائمة العائلة (الأطفال ونصوصهم والمهام والنجوم والمكافآت ورمز الكبار) في هذا المتصفح فقط، على هذا الجهاز، ما لم تُحفظ نسخة منها بزرّ «حفظ نسخة»: فتكون النسخة ملفًا، من دون رمز الكبار، في المكان الذي يحفظ فيه المتصفح التنزيلات. وللتحقّق من نص أو قراءته بصوت مسموع يُرسَل النص ولغته إلى خادم Mommy، ومعهما الفئة العمرية للطفل عند التحقّق من التسميع أو الإملاء؛ أمّا التحقّق من القرآن فيُرسَل فيه رقم السورة وأرقام الآيات بدلًا منها. ولا يحفظ الخادم النصوص ولا الفئة العمرية، ويُدوَّن في سجلّه اللغة ونوع التحقّق وأرقام الآيات.',
      fam_tasks_of: 'الطفل',
      fam_tasks_nochild: 'يُرجى إضافة طفل أولًا في قسم «الأطفال».',
      fam_tasks_empty: 'لا توجد مهام بعد.',
      fam_tasks_archived: 'المهام المؤرشفة: {n}',
      fam_task_new: 'مهمة جديدة',
      fam_task_edit_title: 'تعديل المهمة',
      fam_edit: 'تعديل',
      fam_archive: 'أرشفة',
      fam_task_archived: 'تمّت أرشفة المهمة.',
      fam_task_saved: 'تمّ حفظ المهمة.',
      fam_task_saved_quran: 'تمّ حفظ المهمة. في نصها كلمات من القرآن الكريم: تُراجَع كلمةً بكلمة، وفي الإملاء يقرؤها أحد الكبار بصوت مسموع.',
      fam_status_assigned: 'مطلوبة',
      fam_status_done: 'منجزة',
      fam_tf_kind: 'نوع المهمة',
      fam_tf_title: 'العنوان (اختياري)',
      fam_tf_title_ph: 'أول كلمات النص',
      fam_tf_text: 'النص',
      fam_tf_qmode: 'طريقة التلاوة',
      fam_tf_quran_note: 'مهمة القرآن الكريم تُراجَع دائمًا كلمة بكلمة على نص Tanzil كما هو.',
      fam_tf_pass: 'مستوى النجاح',
      fam_tf_pass_meaning: 'في طريقة «المعنى» تنجح المهمة عندما يكون المعنى نفسه من دون فكرة ناقصة.',
      fam_tf_stars: 'النجوم',
      fam_tf_due: 'الموعد (اختياري)',
      fam_tf_reward: 'المكافأة (اختيارية)',
      fam_tf_reward_text: 'المكافأة',
      fam_tf_reward_ph: 'مثلًا: بوظة',
      fam_tf_reward_emoji: 'صورة المكافأة',
      fam_save: 'حفظ',
      fam_err_quran_task: 'هذا النص من القرآن الكريم. يُرجى إنشاء مهمة من نوع «القرآن الكريم» بدلًا من ذلك.',
      fam_err_quran_meaning_task: 'في هذا النص كلمات من القرآن الكريم، والتطبيق لا يحكم أبدًا على معاني القرآن الكريم، لذلك لا يُتاح له «المعنى». وقد اختيرت «كلمة بكلمة»، فيُرجى مراجعة المهمة وحفظها مرة أخرى.',
      fam_err_quran_unmarked_task: 'لا يصلح هذا النص لمهمة إملاء: وجد الصوت فيه كلمات من القرآن الكريم تعذّر تحديدها ليقرأها أحد الكبار. ولكنه يصلح لمهمة تسميع كلمة بكلمة.',
      fam_err_quran_diff_task: 'بعض كلمات القرآن الكريم في هذا النص ليست كما في المصحف، كما هو مبيَّن تحت النص. يُرجى استخدام نص المصحف، أو الضغط على «حفظ» مرة أخرى لإبقاء النص كما هو.',
      fam_make_quran_task: 'إنشاء مهمة القرآن الكريم بهذه الآيات',
      fam_err_offline: 'تعذّر التحقّق من النص: الخادم غير متاح. بقي النموذج كما هو، ويُرجى المحاولة مرة أخرى عند عودة الخادم.',
      fam_err_quran_range: 'يُرجى اختيار آيات صحيحة: خمسون آية على الأكثر، داخل السورة.',
      fam_err_due: 'يُرجى اختيار تاريخ صحيح.',
      fam_page_has_quran: 'يبدو أن هذه الصفحة آيات من القرآن الكريم فقط. يُرجى إنشاء مهمة من نوع «القرآن الكريم» لها.',
      fam_child_add: 'إضافة طفل',
      fam_child_new_title: 'طفل جديد',
      fam_child_edit_title: 'تعديل ملف الطفل',
      fam_remove: 'حذف',
      fam_child_remove_q: 'حذف ملف {name}؟ تُحذف أيضًا كل المهام والنجوم والمكافآت الخاصة بهذا الملف على هذا الجهاز، ولا يمكن التراجع عن ذلك.',
      fam_child_removed: 'تمّ حذف الملف وكل بياناته.',
      fam_child_saved: 'تمّ الحفظ.',
      fam_quran_title: 'سورة {name} {from}–{to}',
      fam_review_best: 'أفضل نتيجة: {pct}',
      fam_review_last: 'آخر نتيجة: {pct}',
      fam_review_attempts: 'المحاولات: {n}',
      fam_review_passed: 'الناجحة: {n}',
      fam_review_improve: 'كلمات صحيحة إضافية في المحاولة الأخيرة: {n}',
      fam_review_improve_one: 'كلمات صحيحة إضافية في المحاولة الأخيرة: {n}',
      fam_res_same_meaning: 'المعنى نفسه',
      fam_res_partly: 'المعنى نفسه جزئيًا',
      fam_res_different: 'معنى آخر',
      fam_res_unclear: 'غير واضح',
      fam_confirm_anyway: 'تأكيد على أي حال',
      fam_confirmed_for: 'تمّ: {stars} لـ{name}.',
      fam_reward_to_give: 'تمّ الفوز بالمكافأة {reward}. وبعد تقديمها، يُرجى تسجيل ذلك في «المكافآت».',
      fam_details: 'التفاصيل',
      fam_detail_created: 'أُنشئت: {date}',
      fam_detail_due: 'الموعد: {date}',
      fam_detail_done: 'أُنجزت: {date}',
      fam_detail_by_app: 'نجح في التطبيق، ومُنحت النجوم فورًا.',
      fam_detail_by_parent: 'سجّل أحد الكبار إنجازه.',
      fam_detail_sent_back: 'أُعيدت: {date}',
      fam_detail_no_try: 'لا توجد محاولة بعد.',
      fam_detail_quran: 'الآيات {from}–{to}',
      fam_detail_mode: 'طريقة التسميع: {mode}',
      fam_detail_anyway_hint: 'لم يحتسب التطبيق هذه المهمة ناجحة. عند سماع الطفل يُنجزها، يمكن تأكيدها على أي حال.',
      fam_detail_anyway_again: 'هذه المهمة مطلوبة من جديد. عند سماع الطفل يُنجزها، يمكن تأكيدها على أي حال.',
      fam_rs_locked: 'تُفتح المكافأة عند إنجاز المهمة.',
      fam_rs_unlocked: 'المكافأة مفتوحة وبانتظار التقديم.',
      fam_rs_given: 'قُدّمت المكافأة.',
      fam_mark_given: 'تسجيل التقديم',
      fam_marked_given: 'سُجّل تقديم المكافأة: {reward}.',
      fam_rw_earned: 'مجموع النجوم المكتسبة: {n}',
      fam_rw_to_give_h: 'مكافآت بانتظار التقديم',
      fam_rw_to_give_empty: 'لا توجد مكافأة بانتظار التقديم.',
      fam_rw_for_task: 'عن المهمة: {title}',
      fam_goals_h: 'أهداف جرّة النجوم',
      fam_goals_empty: 'لا توجد أهداف بعد. الهدف مكافأة يجمع الطفل النجوم من أجلها.',
      fam_goal_cost: 'النجوم المطلوبة: {n}',
      fam_goal_enough: 'النجوم تكفي!',
      fam_goal_short: 'النجوم الناقصة: {n}',
      fam_goal_give: 'تقديم',
      fam_goal_given_on: 'قُدّم: {date}',
      fam_goal_add: 'إضافة هدف',
      fam_goal_new: 'هدف جديد',
      fam_goal_cost_label: 'النجوم المطلوبة (من ١ إلى ٥٠٠)',
      fam_goal_added: 'تمّت إضافة الهدف.',
      fam_goal_removed: 'تمّ حذف الهدف.',
      fam_goal_given_now: 'تمّ تقديم {reward}. النجوم في الجرّة: {n}.',
      fam_err_cost: 'يُرجى كتابة عدد النجوم من ١ إلى ٥٠٠.',
      fam_err_reward_text: 'يُرجى كتابة المكافأة.',
      fam_err_not_enough: 'النجوم في الجرّة لا تكفي لهذا الهدف بعد.',
      fam_surprise_h: 'تقديم مفاجأة',
      fam_surprise_about: 'يمكن تقديم مفاجأة في أي وقت، لا بعد المهام فقط. يراها الطفل مرة واحدة في صفحته الرئيسية.',
      fam_surprise_text: 'المفاجأة',
      fam_surprise_ph: 'مثلًا: نزهة في الحديقة',
      fam_surprise_give: 'تقديم المفاجأة',
      fam_surprise_done: 'المفاجأة جاهزة، وستظهر لـ {name} في الصفحة الرئيسية.',
      fam_surprise_unseen: 'لم تُشاهَد بعد: {list}',
      fam_err_surprise_text: 'يُرجى كتابة المفاجأة.',
      fam_adjust_h: 'تعديل النجوم',
      fam_adjust_about: 'للتصحيح: لا تُؤخذ النجوم أبدًا بسبب محاولة لم تنجح، ولا تنزل الجرّة تحت الصفر. ويمكن أيضًا استرجاع نجوم مهمة من السجلّ أدناه.',
      fam_adjust_way: 'نوع التعديل',
      fam_adjust_add: 'إضافة نجوم',
      fam_adjust_take: 'إنقاص نجوم',
      fam_adjust_n: 'عدد النجوم (من ١ إلى ٥٠٠)',
      fam_adjust_note: 'السبب',
      fam_adjust_note_ph: 'مثلًا: مهمة أُنجزت على الورق',
      fam_adjust_done: 'تمّ الحفظ. النجوم في الجرّة: {n}.',
      fam_adjust_limited: 'أُنقص ما في الجرّة فقط، وصارت الآن صفرًا.',
      fam_err_note: 'يُرجى كتابة السبب.',
      fam_err_no_stars: 'لا توجد نجوم لإنقاصها.',
      fam_history_h: 'سجلّ النجوم',
      fam_history_empty: 'لا توجد نجوم بعد.',
      fam_led_task: 'مهمة: {title}',
      fam_led_task_gone: 'مهمة',
      fam_led_goal: 'هدف مُقدَّم: {reward}',
      fam_led_goal_gone: 'هدف مُقدَّم',
      fam_led_adjust: 'تعديل: {note}',
      fam_led_adjust_plain: 'تعديل',
      fam_led_carry: 'نجوم سابقة مجموعة معًا',
      fam_show_all: 'عرض الكل ({n})',
      fam_show_less: 'عرض أقل',
      fam_pin_change: 'تغيير الرمز',
      fam_pin_change_title: 'تغيير الرمز',
      fam_pin_change_intro: 'يُرجى كتابة الرمز الحالي أولًا.',
      fam_pin_change_new: 'يُرجى اختيار الرمز الجديد (من ٤ إلى ٦ أرقام) وكتابته مرتين.',
      fam_pin_changed: 'تمّ تغيير الرمز.',
      fam_continue: 'متابعة',
      fam_set_lang_h: 'لغة قسم الكبار',
      fam_set_lang_hint: 'لقسم الكبار والرمز. يحتفظ كل طفل بلغته (في «الأطفال»).',
      fam_set_lang_saved: 'تمّ الحفظ.',
      fam_set_delete_h: 'حذف كل البيانات من هذا الجهاز',
      fam_set_delete_about: 'يحذف كل الأطفال والمهام والنجوم والمكافآت والرمز والإعدادات، من هذا الجهاز فقط (ولا يحذف نسخة محفوظة في ملف). ثم يبدأ التطبيق من جديد كما في اليوم الأول.',
      fam_delete: 'حذف كل البيانات',
      fam_delete_q1: 'حذف كل بيانات العائلة من هذا الجهاز؟ لا يمكن التراجع عن ذلك.',
      fam_delete_q2: 'تأكيد أخير: ستُحذف كل بيانات الأطفال والمهام والنجوم والمكافآت، والرمز أيضًا.',
      fam_delete_final: 'حذف كل شيء',
      fam_delete_failed: 'تعذّر حذف البيانات: لا يسمح هذا المتصفح بذلك الآن.',
      fam_notice_deleted: 'حُذفت كل بيانات العائلة من هذا الجهاز.',
      fam_copy_h: 'نسخة من قائمة العائلة',
      fam_copy_about: 'تُحفظ قائمة العائلة في هذا المتصفح، ولهذا العنوان فقط. وإذا تغيّر عنوان Mommy (رابط جديد) تكون القائمة فارغة في العنوان الجديد: يُرجى حفظ نسخة هنا مسبقًا، ثم فتحها في العنوان الجديد. وتفيد النسخة أيضًا في نقل القائمة إلى جهاز آخر.',
      fam_copy_save: 'حفظ نسخة',
      fam_copy_load: 'فتح نسخة',
      fam_copy_note: 'يحتوي الملف على أسماء الأطفال وفئاتهم العمرية ونصوصهم ومهامهم ونجومهم ومكافآتهم، ولا يحتوي على الرمز. والملف غير مشفَّر، فيُرجى إبقاؤه خاصًّا.',
      fam_copy_saved: 'يحفظ المتصفح النسخة باسم {name}، في مجلد التنزيلات عادةً.',
      fam_copy_summary_title: 'في هذه النسخة، المحفوظة في {date}:',
      fam_copy_summary_title_nodate: 'في هذه النسخة:',
      fam_copy_children: 'الأطفال: {n}',
      fam_copy_child_line: '{name} — المهام: {tasks}، النجوم: {stars}',
      fam_copy_repaired: 'كان جزء من هذه النسخة تالفًا، وأُصلح قدر الإمكان.',
      fam_copy_replace_q: 'استبدال قائمة العائلة على هذا الجهاز بالنسخة؟ يحلّ ما في النسخة محلّ الأطفال والمهام والنجوم والمكافآت هنا، ويبقى الرمز والموافقات على هذا الجهاز كما هي.',
      fam_copy_save_first: 'للاحتفاظ بالقائمة الحالية أيضًا، يُرجى الضغط على «حفظ نسخة» أولًا.',
      fam_copy_replace: 'استبدال',
      fam_copy_loaded: 'تمّ: صار هذا الجهاز يستخدم قائمة العائلة التي في النسخة.',
      fam_copy_setup_hint: 'هل توجد نسخة من قائمة العائلة من عنوان آخر أو جهاز آخر؟ يمكن فتحها هنا، فيُستخدم ما فيها من أطفال ومهام ونجوم ومكافآت بدلًا من الطفل الأول.',
      fam_copy_setup_using: 'سيُستخدم ما في هذه النسخة من أطفال ومهام ونجوم ومكافآت. أمّا الموافقات والرمز فليست في النسخة، وتُطلب هنا كما لعائلة جديدة.',
      fam_copy_drop: 'عدم استخدام هذه النسخة',
      fam_copy_err_not_copy: 'هذا الملف ليس نسخة من قائمة عائلة في Mommy.',
      fam_copy_err_damaged: 'هذه النسخة تالفة، ولا يمكن استخدامها.',
      fam_copy_err_too_big: 'هذا الملف أكبر من أن يكون نسخة من قائمة عائلة في Mommy (أكثر من ٢ ميغابايت).',
      fam_copy_err_newer: 'حُفظت هذه النسخة بإصدار أحدث من Mommy، ولا يستطيع هذا الإصدار قراءتها.',
      fam_copy_err_read: 'تعذّرت قراءة الملف. يُرجى المحاولة مرة أخرى.',
      fam_copy_err_save_big: 'قائمة العائلة أكبر من أن تُحفظ في نسخة (أكثر من ٢ ميغابايت).',
      fam_copy_err_save: 'تعذّر حفظ النسخة في هذا المتصفح.',
      fam_copy_err_empty: 'لا تضمّ هذه النسخة أيّ طفل، فلا يوجد فيها ما يمكن استخدامه.',
      fam_copy_err_save_empty: 'لا تضمّ قائمة العائلة أيّ طفل بعد، فلا يوجد ما يمكن حفظه.',
      fam_copy_err_full: 'مساحة التخزين في هذا المتصفح ممتلئة، فتعذّر استخدام النسخة. يُرجى إفراغ بعض المساحة (مثل بيانات مواقع قديمة) ثم المحاولة مرة أخرى.',
    },
  };

  const LANG_NAMES = { en: 'English', fr: 'Français', ar: 'العربية' };
  const KIND_ICONS = { recite: 'i-mic', dictation: 'i-pencil', quran: 'i-book' };
  // (Redesign) Only what needs a grown-up: nothing waits for the parent any more.
  const PARENT_SECTIONS = ['rewards', 'tasks', 'children', 'settings'];
  const MAX_AYAT = 50;
  const STAR = '⭐';
  const LEDGER_SHOWN = 10; // history entries shown before "Show all"
  const CHILD_SCREENS = ['home', 'texts', 'prepare', 'recite', 'dictation', 'quran'];

  // ===========================================================================
  // Module state
  // ===========================================================================

  const R = window.MommyRewards || null;
  let app = null; // window.MommyApp, once attached

  const store = {
    doc: null, // the family document (validated), or null before the first setup
    raw: null, // the JSON last read or written here (our own writes are not "external")
    memoryOnly: false, // storage is not available: the session runs in memory
  };

  const session = {
    childId: null, // the child learning in this tab (not taken from another tab)
    // The parent area was unlocked: it stays open while the grown-up moves around the app,
    // and locks when the page is hidden, after 3 minutes without use in it, or by "Close".
    parentOpen: false,
    section: 'rewards',
    task: null, // {id, kind} of the task being done
    setupLang: null,
    setupChildLangTouched: false,
    ptChildId: null, // the child whose tasks the parent area shows
    // The open task form: {id: taskId | null, childId, token, diffSeen}; diffSeen is the
    // text whose differences from the mushaf were shown (a second "Save" keeps it as typed).
    taskForm: null,
    childForm: null, // {id: childId | null}
    removing: null, // childId waiting for the remove confirmation
    detailTaskId: null, // the task whose details are open (Tasks)
    undoing: null, // {taskId, where: 'tasks' | 'rewards'}: "Take the stars back", asked in place
    rwForm: null, // {kind: 'goal' | 'surprise' | 'adjust', childId}: the open form of Rewards
    ledgerAll: false, // the whole history of the stars is shown (else the newest entries)
    deleting: 0, // "delete all data": 0, or the confirmation step shown (1, then 2)
    copy: null, // Settings: a copy read from a file (readFamilyCopy), waiting for "Replace"
    setupCopy: null, // the setup: a copy read from a file, used instead of a first child
    whoAdd: false, // "Who is learning?": the form of a new profile is open
    deletingText: null, // My texts: the text whose deletion is asked in place
  };

  // ===========================================================================
  // Small helpers
  // ===========================================================================

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    return app.el(tag, attrs, children);
  }

  function nowIso() {
    return new Date().toISOString();
  }

  function t(key, vars) {
    return app.t(key, vars);
  }

  function parentLang() {
    return store.doc ? store.doc.parent.uiLang : app.uiLang();
  }

  /**
   * A translated sentence as DOM nodes: {placeholders} take numbers (formatted with the
   * digits of the language), plain strings, or {user: text} for text a person typed,
   * which becomes a <bdi> (its direction cannot scramble the sentence around it).
   */
  function tNodes(key, vars, lang) {
    const l = lang || app.uiLang();
    const tpl = app.tIn(l, key);
    const frag = document.createDocumentFragment();
    let last = 0;
    const re = /\{(\w+)\}/g;
    let m;
    while ((m = re.exec(tpl))) {
      if (m.index > last) frag.append(tpl.slice(last, m.index));
      const v = vars ? vars[m[1]] : undefined;
      if (v === undefined) frag.append(m[0]);
      else if (typeof v === 'number') frag.append(app.fmtNum(v, l));
      else if (v && typeof v === 'object' && 'user' in v) frag.append(el('bdi', null, String(v.user)));
      else frag.append(String(v));
      last = m.index + m[0].length;
    }
    if (last < tpl.length) frag.append(tpl.slice(last));
    return frag;
  }

  function setNodes(node, key, vars, lang) {
    node.textContent = '';
    node.append(tNodes(key, vars, lang));
  }

  /** Text a person typed, shown on its own: a <bdi> with its own direction. */
  function userText(text, cls) {
    return el('bdi', { class: cls || null, dir: 'auto' }, String(text));
  }

  function svgIcon(id) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    const use = document.createElementNS(ns, 'use');
    use.setAttribute('href', '#' + id);
    svg.append(use);
    return svg;
  }

  function isRewardsError(err, code) {
    return !!err && err.name === 'RewardsError' && (!code || err.code === code);
  }

  /** "🍦 ice cream" for a reward {text, emoji}. */
  function rewardLabel(r) {
    return (r.emoji ? r.emoji + ' ' : '') + r.text;
  }

  /** A due date 'YYYY-MM-DD' in the UI language (Arabic-Indic digits in Arabic). */
  function fmtDay(day, lang) {
    const l = lang || app.uiLang();
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day || '');
    if (!m) return '';
    const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    let s;
    try {
      s = new Intl.DateTimeFormat(l === 'ar' ? 'ar-u-nu-arab' : l, { day: 'numeric', month: 'long', timeZone: 'UTC' }).format(date);
    } catch (e) {
      s = day;
    }
    return l === 'ar' ? app.arabicDigits(s) : s;
  }

  /** A time ('2026-11-11T14:05:00Z') as a date, or a date and time, in the UI language. */
  function fmtDate(iso, withTime, lang) {
    const l = lang || app.uiLang();
    const date = new Date(iso);
    if (!iso || Number.isNaN(date.getTime())) return '';
    const opts = { day: 'numeric', month: withTime ? 'short' : 'long' };
    if (date.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    if (withTime) {
      opts.hour = '2-digit';
      opts.minute = '2-digit';
    }
    let s;
    try {
      s = new Intl.DateTimeFormat(l === 'ar' ? 'ar-u-nu-arab' : l, opts).format(date);
    } catch (e) {
      s = iso.slice(0, 10);
    }
    return l === 'ar' ? app.arabicDigits(s) : s;
  }

  /** A share of words right (0..1) as a percentage; below 1 it never rounds up to 100. */
  function fmtPct(x, lang) {
    const l = lang || app.uiLang();
    const v = Math.max(0, Math.min(1, Number(x) || 0));
    const n = v >= 1 ? 100 : Math.floor(v * 100);
    if (l === 'ar') return app.arabicDigits(n) + '٪';
    if (l === 'fr') return n + '\u202f%';
    return n + '%';
  }

  /** A whole number typed in a field (Arabic-Indic digits accepted); NaN otherwise. */
  function numberValue(sel) {
    const v = app.asciiDigits($(sel).value).trim();
    return /^[0-9]{1,4}$/.test(v) ? Number(v) : NaN;
  }

  /**
   * A status line made of translated sentences ([key, vars] pairs, see tNodes), so that
   * names and rewards typed by people are <bdi> of their own. Not repainted on a language
   * change: the parent's language change clears the parent area's statuses.
   */
  function say(node, parts, error) {
    app.clearStatus(node);
    const list = typeof parts === 'string' ? [[parts]] : parts;
    list.forEach((p, i) => {
      if (i) node.append(' ');
      node.append(tNodes(p[0], p[1]));
    });
    node.classList.toggle('is-error', !!error);
  }

  /** m:ss for a wait, with the digits of the language. */
  function fmtWait(ms, lang) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    const s = Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
    return lang === 'ar' ? app.arabicDigits(s) : s;
  }

  function randomInt(lo, hi) {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return lo + (a[0] % (hi - lo + 1));
  }

  // ===========================================================================
  // Storage: the ONE place that loads and saves the family document
  // ===========================================================================

  function storage() {
    try {
      return window.localStorage || null;
    } catch (e) {
      return null;
    }
  }

  function isQuota(err) {
    return !!err && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED' || err.code === 22 || err.code === 1014);
  }

  /** A parent-visible notice about the stored data (never silent). */
  function notice(key) {
    const box = $('#data-notice');
    app.setT($('#data-notice-text'), key);
    box.hidden = false;
  }

  function storageFailed(err) {
    if (isQuota(err)) {
      notice('fam_notice_quota');
    } else {
      store.memoryOnly = true;
      notice('fam_notice_memory');
    }
  }

  /** Keep a document that cannot be used as it is under its own key; true when kept. */
  function keepAside(raw) {
    const ls = storage();
    if (!ls) return false;
    try {
      ls.setItem(R.CORRUPT_KEY_PREFIX + nowIso(), raw);
      return true;
    } catch (err) {
      storageFailed(err);
      return false;
    }
  }

  /** The stored document, migrated or repaired as needed; null for a first run. */
  function loadDoc() {
    const ls = storage();
    let raw = null;
    let v1 = null;
    try {
      if (!ls) throw new Error('no storage');
      raw = ls.getItem(R.STORAGE_KEY);
      if (raw === null) v1 = ls.getItem(R.V1_KEY);
    } catch (err) {
      storageFailed(err);
      return null;
    }
    if (raw === null) {
      if (v1 === null) return null;
      // An existing v1 profile: one child; the PIN is created when the parent area opens.
      const doc = R.migrateV1(v1, nowIso(), { lang: app.uiLang() });
      if (commit(doc)) {
        try {
          ls.removeItem(R.V1_KEY); // only once the v2 document is saved
        } catch (e) {
          /* the v1 key stays; it is not read again while v2 exists */
        }
      }
      return doc;
    }
    const v = R.validateDoc(raw);
    if (!v.ok) {
      // Never overwritten silently: kept aside, then a fresh start, with a notice.
      if (keepAside(raw)) {
        try {
          ls.removeItem(R.STORAGE_KEY);
        } catch (e) {
          /* the next save replaces it; the copy is kept */
        }
      }
      notice('fam_notice_corrupt');
      return null;
    }
    store.raw = raw;
    if (v.repaired.length) {
      if (keepAside(raw)) commit(v.doc);
      notice('fam_notice_repaired');
    }
    return v.doc;
  }

  /** Save the whole document (after every change). Returns false when it was not stored. */
  function commit(doc) {
    store.doc = doc;
    const ls = storage();
    if (!ls || store.memoryOnly) {
      if (!store.memoryOnly) storageFailed(new Error('no storage'));
      return false;
    }
    const json = JSON.stringify(doc);
    try {
      ls.setItem(R.STORAGE_KEY, json);
      store.raw = json;
      return true;
    } catch (err) {
      storageFailed(err);
      return false;
    }
  }

  /**
   * Apply a rewards.js operation (doc -> doc) and save it. Throws what it throws.
   * Compare and swap: when another tab saved since this tab last read or wrote (its
   * storage event may not have arrived yet), the operation runs on that newer document,
   * so the other tab's change is never overwritten; the screen is drawn again after.
   */
  function update(fn) {
    return updateSaved(fn).doc;
  }

  /**
   * update(), saying also whether the document was stored: {doc, saved, before}, with
   * `before` the document the operation ran on. saved is false when storage refused it
   * (commit: full, or no storage at all, store.memoryOnly); this tab then holds `doc`
   * all the same, as after any update.
   */
  function updateSaved(fn) {
    const external = adoptStored();
    const before = store.doc;
    const next = fn(before, nowIso());
    const saved = commit(next);
    if (external) setTimeout(() => store.doc && afterExternalChange(), 0);
    return { doc: next, saved, before };
  }

  /** Take the stored document when it is newer than this tab's; true when it was. */
  function adoptStored() {
    const ls = storage();
    if (!ls || store.memoryOnly) return false;
    let raw;
    try {
      raw = ls.getItem(R.STORAGE_KEY);
    } catch (err) {
      return false;
    }
    if (raw === store.raw) return false;
    if (raw === null) {
      // Deleted in another tab ("delete all data"): never written back.
      forgetFamily();
      notice('fam_notice_deleted');
      throw new Error('the family data was deleted in another tab');
    }
    const v = R.validateDoc(raw);
    if (!v.ok) return false; // unreadable: this tab's document is written over it
    store.doc = v.doc;
    store.raw = raw;
    return true;
  }

  /** Another tab changed the stored document: reload it and draw the screen again. */
  function onStorage(e) {
    if (!R || !app) return;
    if (e.key !== null && e.key !== R.STORAGE_KEY) return;
    const ls = storage();
    let raw = null;
    try {
      raw = ls ? ls.getItem(R.STORAGE_KEY) : null;
    } catch (err) {
      return;
    }
    if (raw === store.raw) return;
    if (raw === null) {
      // All the family data was deleted in another tab: back to the setup.
      forgetFamily();
      notice('fam_notice_deleted');
      return;
    }
    const v = R.validateDoc(raw);
    if (!v.ok) return; // keep what this tab has; the next save writes it back
    store.doc = v.doc;
    store.raw = raw;
    afterExternalChange();
  }

  /**
   * The family document is gone (deleted here or in another tab): the session forgets
   * the child, the parent area and every open form, and the app starts on the family
   * setup again, in the language the grown-ups had.
   */
  function forgetFamily() {
    const lang = store.doc ? store.doc.parent.uiLang : app.uiLang();
    store.doc = null;
    store.raw = null;
    if ($('#pin-dialog').open) closePin(false);
    if (app.taskRunning()) app.leaveTask();
    Object.assign(session, {
      childId: null, parentOpen: false, section: 'rewards', task: null, ptChildId: null,
      setupLang: lang, setupChildLangTouched: false,
    });
    closeTaskForm();
    closeChildForm();
    hideRemoveConfirm();
    resetParentForms();
    resetSetupForm(lang);
    syncApp();
    app.go('start');
  }

  function afterExternalChange() {
    const doc = store.doc;
    if (session.childId && !doc.children.some((c) => c.id === session.childId)) session.childId = null;
    if (session.task) {
      const task = doc.tasks.find((x) => x.id === session.task.id);
      if (!task || task.childId !== session.childId) app.leaveTask();
    }
    if (session.ptChildId && !doc.children.some((c) => c.id === session.ptChildId)) session.ptChildId = null;
    if (session.taskForm && session.taskForm.id && !doc.tasks.some((x) => x.id === session.taskForm.id && (x.status === 'assigned' || x.status === 'ready'))) closeTaskForm();
    if (session.childForm && session.childForm.id && !doc.children.some((c) => c.id === session.childForm.id)) closeChildForm();
    if (session.removing && !doc.children.some((c) => c.id === session.removing)) hideRemoveConfirm();
    if (session.detailTaskId && !doc.tasks.some((x) => x.id === session.detailTaskId)) session.detailTaskId = null;
    if (session.undoing && !doc.tasks.some((x) => x.id === session.undoing.taskId && x.status === 'done')) session.undoing = null;
    syncApp();
    const screen = app.screen();
    const allowed = route(screen);
    if (allowed !== screen) app.go(allowed);
    else redraw();
  }

  // ===========================================================================
  // The document seen by app.js: the active child and the consent
  // ===========================================================================

  function activeChild() {
    if (!store.doc || !session.childId) return null;
    return store.doc.children.find((c) => c.id === session.childId) || null;
  }

  function syncApp() {
    const d = store.doc;
    app.setConsent({ consent: !!(d && d.parent.consentAt), aiConsent: !!d && R.hasAiConsent(d) });
    updateTaskOfflineNote();
    const c = activeChild();
    app.setChild(c ? { id: c.id, nickname: c.nickname, age: c.age, lang: c.lang, quran: c.quran } : null);
    if (c && CHILD_SCREENS.includes(app.screen())) app.setUiLang(c.lang);
  }

  /** The child's Quran screen state (surah, range, Juz' Amma), kept in the profile. */
  function onQuranPrefs(prefs) {
    const c = activeChild();
    if (!c || !prefs) return;
    try {
      update((d, now) => R.updateChild(d, c.id, { quran: { surah: prefs.surah, from: prefs.from, to: prefs.to, juzAmma: !!prefs.juzAmma } }, now));
    } catch (err) {
      /* a value out of range is simply not kept */
    }
  }

  // ===========================================================================
  // Hooks for app.js: which screen, in which language
  // ===========================================================================

  function route(screen) {
    if (!store.doc) return 'start';
    const fallback = session.childId ? 'home' : 'who';
    if (screen === 'start') return fallback;
    if (screen === 'parent') return session.parentOpen ? 'parent' : fallback;
    if (screen === 'who') return 'who';
    if (CHILD_SCREENS.includes(screen)) return session.childId ? screen : 'who';
    return fallback;
  }

  function langFor(screen) {
    if (!store.doc) return session.setupLang;
    if (CHILD_SCREENS.includes(screen)) {
      const c = activeChild();
      if (c) return c.lang;
    }
    return store.doc.parent.uiLang;
  }

  function enter(screen) {
    if (screen === 'start') renderSetup();
    else if (screen === 'who') renderWho();
    else if (screen === 'home') renderHome();
    else if (screen === 'texts') renderTexts();
    else if (screen === 'recite' || screen === 'dictation') renderPickLists();
    else if (screen === 'parent') renderParent();
    if (session.task) renderBanner();
  }

  function leave(screen) {
    if (screen === 'parent') {
      // (Redesign) Leaving the parent area does not lock it (the 3-minute timer, a hidden
      // page and "Close" do); its open forms close.
      closeTaskForm();
      closeChildForm();
      hideRemoveConfirm();
      resetParentForms();
      session.detailTaskId = null;
    } else if (screen === 'texts') {
      session.deletingText = null;
    } else if (screen === 'who') {
      closeWhoAdd();
    }
  }

  /** The visible family screen again (after a change, or in another language). */
  function redraw() {
    const screen = app.screen();
    if (screen === 'start') renderSetupCopy();
    else if (screen === 'who') renderWho();
    else if (screen === 'home') renderHome();
    else if (screen === 'texts') renderTexts();
    else if (screen === 'recite' || screen === 'dictation') renderPickLists();
    else if (screen === 'parent') renderParent();
    if (session.task) renderBanner();
  }

  // ===========================================================================
  // Emoji pickers (avatars, reward pictures): a radio group of a fixed list
  // ===========================================================================

  function renderEmojiPick(fieldset, list, selected) {
    for (const n of $$('.emoji-opt', fieldset)) n.remove();
    const name = fieldset.dataset.name;
    list.forEach((emoji, i) => {
      const id = name + '-' + i;
      const input = el('input', { type: 'radio', name, value: emoji, id, class: 'emoji-radio' });
      input.checked = emoji === selected;
      fieldset.append(el('span', { class: 'emoji-opt' }, [input, el('label', { for: id, class: 'emoji-face' }, emoji)]));
    });
    if (!$('input:checked', fieldset)) {
      const first = $('input', fieldset);
      if (first) first.checked = true;
    }
  }

  function pickedEmoji(fieldset) {
    const r = $('input:checked', fieldset);
    return r ? r.value : null;
  }

  // ===========================================================================
  // First run: the family setup (on the start screen)
  // ===========================================================================

  function initSetup() {
    const form = $('#setup-form');
    session.setupLang = app.uiLang();
    $('#setup-lang').value = session.setupLang;
    $('#child-lang').value = session.setupLang;
    renderEmojiPick($('#setup-avatars'), R.AVATARS, R.AVATARS[0]);
    $('#setup-lang').addEventListener('change', (e) => {
      const lang = e.target.value;
      if (!R.LANGS.includes(lang)) return;
      session.setupLang = lang;
      if (!session.setupChildLangTouched) $('#child-lang').value = lang;
      app.setUiLang(lang);
    });
    $('#child-lang').addEventListener('change', () => {
      session.setupChildLangTouched = true;
    });
    // The AI consent needs the general one: its box waits for the first one.
    $('#consent').addEventListener('change', syncSetupAiBox);
    syncSetupAiBox();
    $('#setup-copy-file').addEventListener('change', onSetupCopyFile);
    $('#setup-copy-drop').addEventListener('click', dropSetupCopy);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitSetup();
    });
    form.hidden = false;
  }

  function renderSetup() {
    $('#setup-form').hidden = !!store.doc;
  }

  /** True while /api/health says Claude is set up (the Claude notice and its box show). */
  function claudeSetUp() {
    const h = app.health();
    return !!h && h.brain === 'claude';
  }

  /** The setup's AI box can be ticked only with the general box; unticking that one clears it. */
  function syncSetupAiBox() {
    const on = $('#consent').checked;
    const ai = $('#ai-consent');
    ai.disabled = !on;
    if (!on) ai.checked = false;
  }

  /** The setup form as on a first run (after "delete all data"), in the grown-ups' language. */
  function resetSetupForm(lang) {
    for (const id of ['#setup-lang', '#child-lang']) $(id).value = lang;
    for (const id of ['#setup-pin', '#setup-pin2', '#nickname']) $(id).value = '';
    $('#age').value = '6-9';
    $('#consent').checked = false;
    syncSetupAiBox();
    renderEmojiPick($('#setup-avatars'), R.AVATARS, R.AVATARS[0]);
    app.clearStatus($('#setup-status'));
    app.clearStatus($('#setup-copy-status'));
    session.setupCopy = null;
    renderSetupCopy();
    $('#btn-start').disabled = false;
  }

  function clearSetupErrors() {
    for (const id of ['setup-pin', 'setup-pin2', 'nickname']) {
      const input = document.getElementById(id);
      const err = document.getElementById(id + '-err');
      if (err) app.clearStatus(err);
      if (input) {
        input.removeAttribute('aria-invalid');
        if (input.getAttribute('aria-describedby') === id + '-err') input.removeAttribute('aria-describedby');
      }
    }
  }

  async function submitSetup() {
    if (store.doc) return;
    const status = $('#setup-status');
    const btn = $('#btn-start');
    const pin1 = $('#setup-pin').value;
    const pin2 = $('#setup-pin2').value;
    const nickname = $('#nickname').value.trim();
    const fail = (key, focus) => {
      clearSetupErrors();
      if (!focus) {
        app.setStatus(status, key, null, { error: true });
        return;
      }
      // Under the field that needs it, and read with it (UX-08).
      app.clearStatus(status);
      let err = document.getElementById(focus.id + '-err');
      if (!err) {
        err = el('p', { class: 'status is-error field-error', id: focus.id + '-err', role: 'alert' });
        focus.after(err);
      }
      app.setStatus(err, key, null, { error: true });
      focus.setAttribute('aria-invalid', 'true');
      focus.setAttribute('aria-describedby', err.id);
      focus.focus();
    };
    clearSetupErrors();
    if (!R.isValidPin(pin1)) return fail('fam_err_pin_format', $('#setup-pin'));
    if (R.normalizePin(pin1) !== R.normalizePin(pin2)) {
      $('#setup-pin2').value = '';
      return fail('fam_err_pin_same', $('#setup-pin2'));
    }
    // With a copy, its children are used instead of a first child (its fields are hidden).
    const copy = session.setupCopy;
    if (!copy && !nickname) return fail('fam_err_nickname', $('#nickname'));
    const consent = $('#consent').checked;
    // The AI consent only from its own box, ticked while it stood under the Claude notice
    // (shown only while /api/health says Claude is set up), and with the general one.
    const aiConsent = consent && claudeSetUp() && $('#ai-consent').checked;
    app.setStatus(status, 'fam_saving');
    btn.disabled = true;
    let doc;
    let child;
    try {
      const now = nowIso();
      doc = R.emptyDoc(now, { uiLang: session.setupLang });
      doc = R.updateParent(doc, { consent, aiConsent }, now);
      doc = await R.setPin(doc, pin1, now);
      if (copy) {
        // The copy's family, with the consents and the PIN given here (rewards.js).
        doc = R.useFamilyCopy(doc, copy.family, now);
      } else {
        const r = R.addChild(doc, { nickname, age: $('#age').value, lang: $('#child-lang').value, avatar: pickedEmoji($('#setup-avatars')) }, now);
        doc = r.doc;
        child = r.child;
      }
    } catch (err) {
      btn.disabled = false;
      if (isRewardsError(err, 'unavailable')) return fail('fam_err_crypto');
      if (isRewardsError(err, 'bad_input') && err.field === 'nickname') return fail('fam_err_nickname', $('#nickname'));
      return fail('error_generic');
    }
    btn.disabled = false;
    if (store.doc) return; // another tab finished a setup meanwhile: keep its document
    // A copy that the storage refuses (full) is not used: the setup stays, with its
    // fields, as nothing was set up (B-R2). Without any storage the session runs in
    // memory, with its notice.
    if (!commit(doc) && copy && !store.memoryOnly) {
      store.doc = null;
      return fail('fam_copy_err_full');
    }
    $('#setup-pin').value = '';
    $('#setup-pin2').value = '';
    app.clearStatus(status);
    // A copy may hold several children: "Who is learning?" lets the family choose.
    session.childId = child ? child.id : null;
    session.setupCopy = null;
    renderSetupCopy();
    syncApp();
    app.go(child ? 'home' : 'who');
  }

  // --- The setup: a copy of the family list instead of a first child -----------

  async function onSetupCopyFile(e) {
    const status = $('#setup-copy-status');
    app.clearStatus(status);
    const res = await readCopyFile(e.target);
    if (!res || store.doc) return;
    if (!res.ok) {
      session.setupCopy = null;
      renderSetupCopy();
      app.setStatus(status, COPY_ERRORS[res.error] || COPY_ERRORS.damaged, null, { error: true });
      return;
    }
    session.setupCopy = res;
    clearSetupErrors(); // a nickname is no longer needed
    renderSetupCopy();
    $('#setup-copy-box').focus();
  }

  /** The copy's summary in place of the first child's fields (or the fields again). */
  function renderSetupCopy() {
    const copy = session.setupCopy;
    $('#setup-copy-box').hidden = !copy;
    $('#setup-first-child').hidden = !!copy;
    if (copy) $('#setup-more').open = true;
    if (copy) renderCopySummary('setup-copy', copy);
  }

  function dropSetupCopy() {
    session.setupCopy = null;
    app.clearStatus($('#setup-copy-status'));
    renderSetupCopy();
    $('#setup-copy-file').focus();
  }

  // ===========================================================================
  // Who is learning?
  // ===========================================================================

  function renderWho() {
    const list = $('#who-list');
    const formOpen = session.whoAdd || !(store.doc && store.doc.children.length);
    list.textContent = '';
    const children = store.doc ? store.doc.children : [];
    for (const c of children) {
      const btn = el('button', { type: 'button', class: 'who-btn', 'data-child': c.id }, [
        el('span', { class: 'who-avatar', 'aria-hidden': 'true' }, c.avatar),
        userText(c.nickname, 'who-name'),
      ]);
      btn.addEventListener('click', () => pickChild(c.id));
      list.append(el('li', null, btn));
    }
    $('#who-empty').hidden = children.length > 0;
    // (Redesign) A child adds their own profile, no PIN; with nobody yet, the form is open.
    const form = $('#who-add');
    if (formOpen && form.hidden) resetWhoAdd();
    form.hidden = !formOpen;
    $('#who-add-open').hidden = formOpen;
    $('#who-add-open').setAttribute('aria-expanded', formOpen ? 'true' : 'false');
  }

  function resetWhoAdd() {
    $('#wa-nick').value = '';
    $('#wa-age').value = '6-9';
    $('#wa-lang').value = store.doc ? store.doc.parent.uiLang : app.uiLang();
    const used = new Set((store.doc ? store.doc.children : []).map((x) => x.avatar));
    renderEmojiPick($('#wa-avatars'), R.AVATARS, R.AVATARS.find((a) => !used.has(a)) || R.AVATARS[0]);
    app.clearStatus($('#wa-status'));
  }

  function openWhoAdd() {
    session.whoAdd = true;
    renderWho();
    $('#who-add-h').focus();
  }

  function closeWhoAdd() {
    session.whoAdd = false;
    if ($('#who-add')) $('#who-add').hidden = true;
  }

  /** The new profile is saved, chosen, and its home opens. */
  function submitWhoAdd() {
    if (!store.doc) return;
    const status = $('#wa-status');
    const input = { nickname: $('#wa-nick').value.trim(), age: $('#wa-age').value, lang: $('#wa-lang').value, avatar: pickedEmoji($('#wa-avatars')) };
    if (!input.nickname) {
      app.setStatus(status, 'fam_wa_err_name', null, { error: true });
      $('#wa-nick').focus();
      return;
    }
    let child;
    try {
      update((d, now) => {
        const r = R.addChild(d, input, now);
        child = r.child;
        return R.setActiveChild(r.doc, r.child.id, now);
      });
    } catch (err) {
      app.setStatus(status, isRewardsError(err, 'bad_input') && err.field === 'nickname' ? 'fam_wa_err_name' : 'error_generic', null, { error: true });
      return;
    }
    session.whoAdd = false;
    session.childId = child.id;
    syncApp();
    app.go('home');
  }

  function pickChild(id) {
    if (!store.doc || !store.doc.children.some((c) => c.id === id)) return;
    session.childId = id;
    try {
      update((d, now) => R.setActiveChild(d, id, now));
    } catch (err) {
      /* the choice still holds for this tab */
    }
    syncApp();
    app.go('home');
  }

  // ===========================================================================
  // The child's home: header (avatar, nickname, star jar), sections, free practice
  // ===========================================================================

  function starsText(n) {
    return STAR.repeat(Math.max(0, Math.min(5, n)));
  }

  function renderHome() {
    const c = activeChild();
    if (!c) return;
    const sum = R.childSummary(store.doc, c.id);
    $('#home-avatar').textContent = c.avatar;
    setNodes($('#home-title'), 'hello_name', { name: { user: c.nickname } });
    setNodes($('#home-jar'), 'fam_jar', { n: sum.balance });
    const goalLine = $('#home-goal');
    const bar = $('#home-goal-bar');
    if (sum.nextGoal) {
      const reward = { user: rewardLabel(sum.nextGoal.reward) };
      if (sum.starsMissing > 0) setNodes(goalLine, sum.starsMissing === 1 ? 'fam_goal_missing_one' : 'fam_goal_missing', { n: sum.starsMissing, reward });
      else setNodes(goalLine, 'fam_goal_reached', { reward });
      $('#home-goal-fill').style.setProperty('--progress', String(sum.goalProgress));
      goalLine.hidden = false;
      bar.hidden = false;
    } else {
      goalLine.textContent = '';
      goalLine.hidden = true;
      bar.hidden = true;
    }
    renderSurprises(sum.unseenSurprises);
    // (Redesign) The parent's tasks are suggestions on top; free practice is always there.
    fillTaskList($('#home-todo'), $('#home-todo-sec'), sum.todo, 'todo');
    fillTaskList($('#home-done'), $('#home-done-sec'), sum.done, 'done');
  }

  /** Unseen surprises show once, as a celebration card. */
  function renderSurprises(list) {
    const box = $('#home-surprises');
    box.textContent = '';
    for (const s of list) {
      const ok = el('button', { type: 'button', class: 'btn btn-primary btn-small' }, t('fam_surprise_ok'));
      ok.addEventListener('click', () => {
        try {
          update((d, now) => R.markSurpriseSeen(d, s.id, now));
        } catch (err) {
          /* already gone */
        }
        renderHome();
        $('#home-title').focus();
      });
      box.append(el('div', { class: 'card celebrate surprise', 'data-surprise': s.id }, [
        el('p', { class: 'celebrate-title' }, [el('span', { 'aria-hidden': 'true' }, '🎉 '), t('fam_surprise_title')]),
        el('p', { class: 'surprise-reward' }, [el('span', { class: 'big-emoji', 'aria-hidden': 'true' }, s.reward.emoji), ' ', userText(s.reward.text)]),
        ok,
      ]));
    }
  }

  /** A list of task cards; its section shows only when it has some. */
  function fillTaskList(list, sectionNode, tasks, section) {
    list.textContent = '';
    for (const task of tasks) list.append(taskCard(task, section));
    sectionNode.hidden = tasks.length === 0;
  }

  /** One task card of the child's home ('todo', 'waiting' or 'done'). */
  function taskCard(task, section) {
    const head = el('div', { class: 'task-card-head' }, [
      el('span', { class: 'kind-icon kind-' + task.kind }, svgIcon(KIND_ICONS[task.kind])),
      el('h3', { class: 'task-title' }, [section === 'done' ? el('span', { 'aria-hidden': 'true' }, '🏆 ') : null, userText(task.title)]),
    ]);
    const meta = el('p', { class: 'task-meta' }, [
      el('span', { class: 'task-kind' }, t('fam_kind_' + task.kind)),
      ' · ',
      el('span', { class: 'task-stars', 'aria-hidden': 'true' }, starsText(task.stars)),
      el('span', { class: 'sr-only' }, t('fam_stars_n', { n: task.stars })),
    ]);
    const lines = [head, meta];
    if (task.reward) {
      lines.push(el('p', { class: 'task-reward' }, [
        el('span', { class: 'sr-only' }, t('fam_reward_label') + ' '),
        el('span', { 'aria-hidden': 'true' }, task.reward.emoji + ' '),
        userText(task.reward.text),
      ]));
    }
    if (section !== 'done') {
      lines.push(el('p', { class: 'task-pass' }, t('fam_pass_line', { rule: passRuleText(task) })));
    }
    if (task.due && section === 'todo') lines.push(el('p', { class: 'task-due' }, t('fam_due', { date: fmtDay(task.due) })));
    // A dictation whose text has Quran parts: a grown-up reads them (UX-04).
    if (section === 'todo' && task.kind === 'dictation') {
      // Shown in place when the server's answer comes (no new drawing of the home).
      const line = el('p', { class: 'task-quran-line gu-child', 'data-quran-for': task.id, hidden: '' }, t('dict_quran_child'));
      const info = textInfoFor(task, () => {
        const later = textInfoFor(task);
        const node = document.querySelector('#screen-home [data-quran-for="' + task.id + '"]');
        if (node && later && later.parts.length) node.hidden = false;
      });
      if (info && info.parts.length) line.hidden = false;
      lines.push(line);
    }
    if (task.sentBackNote && section === 'todo') {
      // "Not yet: try again" with a note from the grown-up: shown kindly, never as a failure.
      lines.push(el('p', { class: 'task-note' }, [el('span', { 'aria-hidden': 'true' }, '💬 '), t('fam_note_label') + ' ', userText(task.sentBackNote)]));
    }
    if (section === 'done' && task.reward) {
      const given = task.rewardStatus === 'given';
      lines.push(el('p', { class: 'reward-state ' + (given ? 'is-given' : 'is-unlocked') }, t(given ? 'fam_reward_given' : 'fam_reward_unlocked')));
    }
    if (section === 'todo') {
      const start = el('button', { type: 'button', class: 'btn btn-primary task-start', 'data-task': task.id }, t('fam_start'));
      start.addEventListener('click', () => startTask(task.id));
      lines.push(start);
    }
    return el('li', { class: 'task-card task-' + section, 'data-task': task.id }, lines);
  }

  // ===========================================================================
  // The task runner
  // ===========================================================================

  function startTask(taskId) {
    const task = R.getTask(store.doc, taskId);
    if (!task || task.childId !== session.childId || task.status !== 'assigned') return;
    session.task = { id: task.id, kind: task.kind };
    const spec = {
      kind: task.kind,
      onResult: (res, node) => onTaskResult(task.id, res, node),
      onLeave: () => {
        session.task = null;
      },
    };
    if (task.kind === 'quran') spec.quran = Object.assign({}, task.quran);
    else {
      spec.text = task.text;
      spec.lang = task.lang;
      if (task.kind === 'recite') spec.mode = task.mode;
    }
    renderBanner();
    app.startTask(spec);
  }

  /** The banner: the title and the pass level of the task being done. */
  function renderBanner() {
    const task = session.task && store.doc ? R.getTask(store.doc, session.task.id) : null;
    const title = $('#task-banner-title');
    const pass = $('#task-banner-pass');
    title.textContent = '';
    pass.textContent = '';
    if (!task) return;
    title.append(el('span', { class: 'kind-icon', 'aria-hidden': 'true' }, svgIcon(KIND_ICONS[task.kind])), userText(task.title));
    pass.textContent = t('fam_pass_line', { rule: passRuleText(task) });
  }

  /**
   * The key of a line that counts words: Arabic has its own forms for 1, 2, 3 to 10 and
   * 11 or more (كلمة واحدة، كلمتان، ٣ كلمات، ١١ كلمة); en and fr have one and many (UX-15).
   */
  function countKey(base, n) {
    if (app.uiLang() === 'ar') {
      if (n === 1) return base + '_one';
      if (n === 2) return base + '_two';
      return n % 100 >= 3 && n % 100 <= 10 ? base + '_few' : base + '_many';
    }
    return n === 1 ? base + '_one' : base;
  }

  /** The pass rule as it follows "Pass:" (lower case after a French colon). */
  function passRuleText(task) {
    const rule = t('fam_pass_' + R.passRule(task));
    return app.uiLang() === 'fr' ? rule.charAt(0).toLocaleLowerCase('fr') + rule.slice(1) : rule;
  }

  /** A check result of the running task: record it, then show what it means. */
  function onTaskResult(taskId, res, node) {
    if (!store.doc || !node) return;
    let out;
    try {
      update((d, now) => (out = R.recordAttempt(d, taskId, res, now)).doc);
    } catch (err) {
      // A result that does not fit the task (it should not happen) is not counted.
      if (isRewardsError(err)) return;
      throw err;
    }
    renderOutcome(node, out.task, out.passed);
  }

  /**
   * Under the usual feedback (what was right, how many words): the improvement line
   * when it is true, then the celebration card (stars and reward) on a pass, or "Try
   * again whenever you are ready". Never a penalty or a countdown.
   */
  function renderOutcome(node, task, passed) {
    node.textContent = '';
    const imp = R.improvement(task);
    if (imp !== null && imp > 0) node.append(el('p', { class: 'improve' }, tNodes(countKey('fam_improve', imp), { n: imp })));
    if (passed) {
      const vars = { stars: starsText(task.stars) };
      if (task.reward) vars.reward = { user: rewardLabel(task.reward) };
      // (Redesign) The stars are in the jar at once: no grown-up step.
      node.append(el('div', { class: 'celebrate' }, [el('p', { class: 'celebrate-title' }, tNodes(task.reward ? 'fam_celebrate_reward' : 'fam_celebrate', vars))]));
    } else {
      node.append(el('p', { class: 'try-again' }, t('fam_try_again')));
    }
    node.hidden = false;
  }

  // ===========================================================================
  // (Redesign) Stars of free practice: a saved text read aloud or written, the Quran section
  // ===========================================================================

  /** A check result of free practice: a star when it passes (rewards.js decides how many). */
  function onPractice(input, res, node) {
    const c = activeChild();
    if (!store.doc || !c || !node) return;
    let out;
    try {
      const r = updateSaved((d, now) => (out = R.awardPractice(d, c.id, input, res, now)).doc);
      if (!out.stars && r.saved === false) return;
    } catch (err) {
      // A result that does not fit (it should not happen), or a text deleted meanwhile.
      if (isRewardsError(err)) return;
      throw err;
    }
    node.textContent = '';
    if (out.why === 'not_passed') {
      node.append(el('p', { class: 'try-again' }, t('fam_try_again')));
    } else {
      const key = out.why === 'star' ? 'fam_practice_star' : out.why === 'again_today' ? 'fam_practice_again' : 'fam_practice_limit';
      node.append(el('div', { class: 'celebrate' }, [el('p', { class: 'celebrate-title' }, t(key))]));
    }
    node.hidden = false;
  }

  // ===========================================================================
  // (Redesign) My texts: the child's saved texts
  // ===========================================================================

  function childTexts() {
    const c = activeChild();
    return c && store.doc ? R.childTexts(store.doc, c.id) : [];
  }

  function textMeta(x) {
    return LANG_NAMES[x.lang] + ' · ' + t(x.mode === 'contextual' ? 'texts_mode_meaning' : 'texts_mode_words');
  }

  function renderTexts() {
    const list = $('#texts-list');
    list.textContent = '';
    const texts = childTexts();
    for (const x of texts) list.append(textItem(x));
    $('#texts-empty').hidden = texts.length > 0;
  }

  function textItem(x) {
    const nameId = 'tx-' + x.id;
    const btn = (cls, key, attr, fn) => {
      const b = el('button', Object.assign({ type: 'button', class: 'btn ' + cls, 'aria-describedby': nameId }, attr), t(key));
      b.addEventListener('click', fn);
      return b;
    };
    const lines = [
      el('h2', { class: 'text-title', id: nameId }, userText(x.title)),
      el('p', { class: 'hint text-meta' }, textMeta(x)),
      el('div', { class: 'text-go' }, [
        btn('btn-primary', 'texts_read', { 'data-text-recite': x.id }, () => app.openText(x, 'recite')),
        btn('', 'texts_dict', { 'data-text-dict': x.id }, () => app.openText(x, 'dictation')),
      ]),
    ];
    if (session.deletingText === x.id) {
      const yes = btn('btn-small btn-danger-ghost', 'texts_delete', { 'data-text-delete-yes': x.id }, () => deleteText(x.id));
      const no = btn('btn-small', 'fam_keep', { 'data-text-delete-no': x.id }, () => {
        session.deletingText = null;
        renderTexts();
        const again = $('#texts-list [data-text-delete="' + x.id + '"]');
        if (again) again.focus();
      });
      lines.push(el('div', { class: 'ptask-actions inline-confirm', role: 'group' }, [el('p', null, t('texts_delete_q')), yes, no]));
    } else {
      lines.push(el('div', { class: 'ptask-actions' }, [
        btn('btn-small', 'texts_edit', { 'data-text-edit': x.id }, () => app.editText(x)),
        btn('btn-small btn-danger-ghost', 'texts_delete', { 'data-text-delete': x.id }, () => {
          session.deletingText = x.id;
          renderTexts();
          const yes = $('#texts-list [data-text-delete-yes="' + x.id + '"]');
          if (yes) yes.focus();
        }),
      ]));
    }
    return el('li', { class: 'text-item', 'data-text': x.id }, lines);
  }

  function deleteText(textId) {
    session.deletingText = null;
    try {
      update((d, now) => R.removeText(d, textId, now));
    } catch (err) {
      renderTexts();
      app.setStatus($('#texts-status'), 'error_generic', null, { error: true });
      return;
    }
    renderTexts();
    app.setStatus($('#texts-status'), 'texts_deleted');
    $('#texts-new').focus();
  }

  function newText() {
    app.clearStatus($('#texts-status'));
    const c = activeChild();
    if (c && childTexts().length >= R.LIMITS.textsPerChild) {
      app.setStatus($('#texts-status'), 'texts_full', { n: R.LIMITS.textsPerChild }, { error: true });
      return;
    }
    app.editText(null);
  }

  /** Read aloud and Dictation without a text: the child's texts to choose from. */
  function renderPickLists() {
    const info = app.pageInfo();
    for (const list of $$('.pick-list')) {
      list.textContent = '';
      if (info.ready || info.task) continue;
      const screen = list.dataset.pick;
      for (const x of childTexts().slice(0, 8)) {
        const b = el('button', { type: 'button', class: 'btn pick-btn', 'data-pick-text': x.id }, [svgIcon('i-doc'), userText(x.title)]);
        b.addEventListener('click', () => app.openText(x, screen));
        list.append(el('li', null, b));
      }
    }
  }

  /**
   * The editor saved a text (app.js, after the server checked it): a new text of the
   * active child, or the change of one. {id, title} or {error: key}.
   */
  function onTextSaved(input) {
    const c = activeChild();
    if (!store.doc || !c) return { error: 'text_not_saved' };
    const fields = { title: input.title || null, text: input.text, lang: input.lang, mode: input.mode };
    let text;
    let saved;
    try {
      const own = input.id && store.doc.texts.some((x) => x.id === input.id && x.childId === c.id);
      if (own) {
        saved = updateSaved((d, now) => R.updateText(d, input.id, fields, now)).saved;
        text = R.getText(store.doc, input.id);
      } else {
        if (!fields.title) delete fields.title;
        saved = updateSaved((d, now) => {
          const r = R.addText(d, c.id, fields, now);
          text = r.text;
          return r.doc;
        }).saved;
      }
    } catch (err) {
      if (isRewardsError(err, 'bad_input') && err.field === 'texts') return { error: 'texts_full' };
      return { error: 'text_not_saved' };
    }
    if (!saved && !store.memoryOnly) return { error: 'text_not_saved' };
    return { id: text.id, title: text.title };
  }

  // ===========================================================================
  // The PIN dialog: create (twice), enter, "Forgot PIN" behind a parental gate
  // ===========================================================================

  // allowCreate: the gate was answered (a forgotten PIN, or the first PIN of a migrated
  // family) or the current PIN was given (a change): only then may a new PIN be set.
  // reset: the new PIN replaces a forgotten one (parent.pinResetAt is set).
  const pin = {
    mode: null, purpose: null, resolve: null, busy: false, timer: null, until: 0, gate: null, intro: null,
    allowCreate: false, reset: false,
  };

  /**
   * Ask for the PIN: 'unlock' the parent area, 'confirm' a task, or 'change' it (the
   * current PIN, then the new one twice). Resolves to true when given (or changed).
   */
  function pinDialog(purpose) {
    return new Promise((resolve) => {
      if (!store.doc) return resolve(false);
      if (pin.resolve) pin.resolve(false);
      pin.resolve = resolve;
      pin.purpose = purpose;
      pin.allowCreate = false;
      pin.reset = false;
      const dlg = $('#pin-dialog');
      // No PIN yet (a family migrated from v1): whoever creates it answers the gate first.
      if (store.doc.parent.pin) setPinMode('enter', null);
      else setPinMode('gate', 'fam_gate_first_intro');
      if (!dlg.open) dlg.showModal();
      focusPin();
    });
  }

  /** The PIN field, or Cancel while the field waits for the backoff. */
  function focusPin() {
    const p1 = $('#pin-1');
    if (!p1.disabled) p1.focus();
    else $('#pin-cancel').focus();
  }

  function pt(key, vars) {
    return app.tIn(parentLang(), key, vars);
  }

  function closePin(result) {
    stopPinTimer();
    $('#pin-1').value = '';
    $('#pin-2').value = '';
    const dlg = $('#pin-dialog');
    const resolve = pin.resolve;
    pin.resolve = null;
    pin.mode = null;
    pin.allowCreate = false;
    pin.reset = false;
    if (dlg.open) dlg.close();
    if (resolve) resolve(result);
  }

  function pinStatus(key, vars, error) {
    const s = $('#pin-status');
    s.setAttribute('aria-live', 'assertive');
    s.textContent = key ? pt(key, vars) : '';
    s.classList.toggle('is-error', !!error);
  }

  /** 'enter', 'create' or 'gate'; `intro` replaces the usual introduction of the mode. */
  function setPinMode(mode, intro) {
    const lang = parentLang();
    const dlg = $('#pin-dialog');
    dlg.setAttribute('lang', lang);
    dlg.setAttribute('dir', app.dirOf(lang));
    stopPinTimer();
    pin.mode = mode;
    pin.intro = intro || null;
    const confirm = pin.purpose === 'confirm';
    const change = pin.purpose === 'change';
    const p1 = $('#pin-1');
    const p2 = $('#pin-2');
    p1.value = '';
    p2.value = '';
    p1.disabled = false;
    $('#pin-ok').disabled = false;
    pinStatus(null);
    if (mode === 'enter') {
      $('#pin-title').textContent = pt(change ? 'fam_pin_change_title' : confirm ? 'fam_pin_confirm_title' : 'fam_pin_enter_title');
      $('#pin-intro').textContent = pt(intro || (change ? 'fam_pin_change_intro' : confirm ? 'fam_pin_confirm_intro' : 'fam_pin_enter_intro'));
      $('#pin-1-label').textContent = pt('fam_pin_label');
      p1.type = 'password';
      $('#pin-f2').hidden = true;
      $('#pin-ok').textContent = pt(change ? 'fam_continue' : confirm ? 'fam_confirm' : 'fam_unlock');
      $('#pin-forgot').hidden = false;
      $('#pin-forgot').textContent = pt('fam_forgot');
      const st = R.pinStatus(store.doc, nowIso());
      if (st.locked) showLocked(st.retryInMs); // "Forgot the PIN?" waits for the pause too
    } else if (mode === 'create') {
      $('#pin-title').textContent = pt(change ? 'fam_pin_change_title' : 'fam_pin_create_title');
      $('#pin-intro').textContent = pt(intro || (change ? 'fam_pin_change_new' : 'fam_pin_create_intro'));
      $('#pin-1-label').textContent = pt('fam_pin_new');
      $('#pin-2-label').textContent = pt('fam_pin_again');
      p1.type = 'password';
      $('#pin-f2').hidden = false;
      $('#pin-ok').textContent = pt(change ? 'fam_save' : 'fam_create');
      $('#pin-forgot').hidden = true;
    } else {
      // The parental gate: a two-digit number times a one-digit number, written in
      // words and answered in digits; wrong answers count toward the PIN's pause.
      const t = randomInt(2, 6);
      const u = randomInt(3, 9);
      pin.gate = { a: 10 * t + u, b: randomInt(3, 9) };
      const a = pt('fam_num_tu', { t: pt('fam_t' + t), u: pt('fam_n' + u) });
      $('#pin-title').textContent = pt(store.doc.parent.pin ? 'fam_gate_title' : 'fam_pin_create_title');
      $('#pin-intro').textContent = pt(intro || 'fam_gate_intro');
      $('#pin-1-label').textContent = pt('fam_gate_q', { a, b: pt('fam_n' + pin.gate.b) });
      p1.type = 'text';
      $('#pin-f2').hidden = true;
      $('#pin-ok').textContent = pt('fam_gate_check');
      $('#pin-forgot').hidden = true;
      const st = R.pinStatus(store.doc, nowIso());
      if (st.locked) showLocked(st.retryInMs);
    }
    $('#pin-cancel').textContent = pt('fam_cancel');
  }

  function stopPinTimer() {
    if (pin.timer) clearInterval(pin.timer);
    pin.timer = null;
  }

  /** The backoff: the remaining time, updated each second, then the field opens again. */
  function showLocked(ms) {
    stopPinTimer();
    pin.until = Date.now() + ms;
    $('#pin-1').disabled = true;
    $('#pin-ok').disabled = true;
    $('#pin-forgot').hidden = true;
    const lang = parentLang();
    pinStatus('fam_pin_locked', { time: fmtWait(ms, lang) }, true);
    pin.timer = setInterval(() => {
      const left = pin.until - Date.now();
      const s = $('#pin-status');
      if (left <= 0) {
        stopPinTimer();
        $('#pin-1').disabled = false;
        $('#pin-ok').disabled = false;
        $('#pin-forgot').hidden = pin.mode !== 'enter';
        pinStatus(null);
        $('#pin-1').focus();
        return;
      }
      s.setAttribute('aria-live', 'off'); // announced once, not every second
      s.textContent = pt('fam_pin_locked', { time: fmtWait(left, lang) });
    }, 1000);
  }

  async function submitPin() {
    if (pin.busy || !pin.mode || !store.doc) return;
    const p1 = $('#pin-1');
    const v1 = p1.value;
    if (pin.mode === 'gate') {
      if (R.pinStatus(store.doc, nowIso()).locked) return;
      const answer = app.asciiDigits(v1).replace(/\s+/g, '');
      if (/^\d+$/.test(answer) && Number(answer) === pin.gate.a * pin.gate.b) {
        // The old PIN stays until the new one is saved: Cancel keeps it.
        pin.allowCreate = true;
        pin.reset = !!store.doc.parent.pin;
        setPinMode('create', pin.reset ? 'fam_pin_reset_intro' : null);
        p1.focus();
      } else {
        let r;
        try {
          update((d, now) => (r = R.applyPinCheck(d, { match: false }, now)).doc);
        } catch (err) {
          return;
        }
        setPinMode('gate', pin.intro);
        if (!r.lockedUntil) pinStatus('fam_gate_wrong', null, true);
        if (!p1.disabled) p1.focus();
        else $('#pin-cancel').focus();
      }
      return;
    }
    pin.busy = true;
    try {
      if (pin.mode === 'create') {
        if (!pin.allowCreate) {
          // Never a new PIN without the gate or the current PIN.
          setPinMode(store.doc.parent.pin ? 'enter' : 'gate', store.doc.parent.pin ? null : 'fam_gate_first_intro');
          return;
        }
        if (!R.isValidPin(v1)) {
          pinStatus('fam_err_pin_format', null, true);
          p1.focus();
          return;
        }
        if (R.normalizePin(v1) !== R.normalizePin($('#pin-2').value)) {
          $('#pin-2').value = '';
          pinStatus('fam_err_pin_same', null, true);
          $('#pin-2').focus();
          return;
        }
        pinStatus('fam_saving');
        // Hash first, then set it on the document as it is now (another tab may have saved).
        const record = await R.hashPin(v1);
        const reset = pin.reset;
        update((d, now) => R.setPinRecord(d, record, now, { reset }));
        closePin(true);
        return;
      }
      // enter
      if (!R.pinStatus(store.doc, nowIso()).locked && !R.isValidPin(v1)) {
        pinStatus('fam_err_pin_format', null, true);
        p1.focus();
        return;
      }
      pinStatus('fam_pin_checking');
      let r = null;
      for (let round = 0; round < 3 && (!r || r.code === 'stale'); round++) {
        const c = await R.checkPin(store.doc, v1, nowIso());
        if (c.locked) {
          r = { ok: false, code: 'locked', retryInMs: c.retryInMs };
          break;
        }
        // The outcome counts on the document as it is now (the backoff lives in it).
        update((d, now) => (r = R.applyPinCheck(d, c, now)).doc);
      }
      if (r.ok) {
        if (pin.purpose === 'change') {
          // The current PIN was right: now the new one, twice.
          pin.allowCreate = true;
          pin.reset = false;
          setPinMode('create', null);
          $('#pin-1').focus();
          return;
        }
        closePin(true);
        return;
      }
      p1.value = '';
      if (r.code === 'locked' || r.lockedUntil) showLocked(r.retryInMs);
      else if (r.code === 'stale') pinStatus('error_generic', null, true);
      else if (r.attemptsLeft > 0) pinStatus('fam_pin_wrong', { n: r.attemptsLeft }, true);
      else pinStatus('fam_pin_wrong_last', null, true);
      if (!p1.disabled) p1.focus();
    } catch (err) {
      if (!store.doc) return;
      if (isRewardsError(err, 'unavailable')) pinStatus('fam_err_crypto', null, true);
      else if (isRewardsError(err, 'bad_state') && !store.doc.parent.pin) setPinMode('gate', 'fam_gate_first_intro');
      else if (isRewardsError(err, 'bad_input')) pinStatus('fam_err_pin_format', null, true);
      else pinStatus('error_generic', null, true);
    } finally {
      pin.busy = false;
    }
  }

  function initPinDialog() {
    const dlg = $('#pin-dialog');
    $('#pin-form').addEventListener('submit', (e) => {
      e.preventDefault();
      submitPin();
    });
    $('#pin-cancel').addEventListener('click', () => closePin(false));
    $('#pin-forgot').addEventListener('click', () => {
      setPinMode('gate');
      $('#pin-1').focus();
    });
    dlg.addEventListener('cancel', (e) => {
      e.preventDefault();
      closePin(false);
    });
    dlg.addEventListener('close', () => {
      if (pin.resolve) closePin(false);
    });
  }

  // ===========================================================================
  // The parent area (behind the PIN)
  // ===========================================================================

  /** The parent area locks after this long without a tap or a key (UX-02). */
  const PARENT_IDLE_MS = 3 * 60 * 1000;
  let parentIdle = null;

  function armParentIdle() {
    if (parentIdle) clearTimeout(parentIdle);
    parentIdle = session.parentOpen ? setTimeout(lockParent, PARENT_IDLE_MS) : null;
  }

  /**
   * Lock the parent area (the page was hidden, or nobody used it for 3 minutes): the
   * phone may be back in a child's hands. "Who is learning?" shows next.
   */
  function lockParent() {
    if (parentIdle) clearTimeout(parentIdle);
    parentIdle = null;
    if (!session.parentOpen) return;
    if ($('#pin-dialog').open && pin.purpose === 'change') closePin(false);
    session.parentOpen = false;
    // On the parent area, the next screen is "Who is learning?"; elsewhere (a child's
    // screen) nothing moves: the area simply asks for the PIN again next time.
    if (app.screen() === 'parent') app.go('who');
  }

  /**
   * A file picker of the parent area ("Load a copy", the task form's photo) hides the page
   * on some phones (Android opens it as another app). That is the grown-up choosing a
   * file, not the app being left: the first hiding within a few seconds of a tap on such
   * an input does not lock the area. The exemption ends as soon as the picker is done
   * without hiding the page (a computer, an iPhone's sheet): a file chosen ('change'),
   * the picker closed ('cancel'), or the window back in front ('focus'); the next hiding
   * is then the app being left (B-R1). On Android the picker's hiding comes before
   * 'change', so it still uses the exemption. The 3-minute timer still runs, and any
   * other hiding locks the area.
   */
  const PICKER_GRACE_MS = 10 * 1000;
  let pickerTappedAt = null;

  function pickerDone() {
    pickerTappedAt = null;
  }

  function initAutoLock() {
    for (const id of ['#ps-copy-file', '#tf-take', '#tf-choose']) {
      const input = $(id);
      input.addEventListener('click', () => {
        pickerTappedAt = Date.now();
      });
      input.addEventListener('change', pickerDone);
      input.addEventListener('cancel', pickerDone);
    }
    window.addEventListener('focus', pickerDone);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      const picker = pickerTappedAt !== null && Date.now() - pickerTappedAt < PICKER_GRACE_MS;
      pickerTappedAt = null;
      if (!picker) lockParent();
    });
    // Only use of the parent area keeps it open: a child using the app does not.
    for (const ev of ['pointerdown', 'keydown', 'input', 'wheel', 'touchstart']) {
      document.addEventListener(ev, () => {
        if (session.parentOpen && (app.screen() === 'parent' || $('#pin-dialog').open)) armParentIdle();
      }, { capture: true, passive: true });
    }
  }

  async function openParent() {
    if (!store.doc) return;
    // (Redesign) Still open (the grown-up went to a child's screen and came back): no PIN.
    if (session.parentOpen) {
      armParentIdle();
      app.go('parent');
      return;
    }
    const ok = await pinDialog('unlock');
    if (!ok) return;
    session.parentOpen = true;
    armParentIdle();
    // Without consent the microphone stays off: the box is in Settings. Otherwise Rewards.
    session.section = store.doc.parent.consentAt ? 'rewards' : 'settings';
    app.go('parent');
  }

  /** After "Forgot PIN": a notice until a grown-up dismisses it (a child may have reset it). */
  function renderPinResetNotice() {
    const box = $('#parent-reset-notice');
    const at = store.doc.parent.pinResetAt;
    box.hidden = !at;
    if (!at) return;
    const lang = parentLang();
    $('#parent-reset-text').textContent = pt('fam_pin_reset_notice', { date: fmtDate(at, true, lang) });
    $('#parent-reset-ok').textContent = pt('fam_dismiss');
  }

  function closeParent() {
    session.parentOpen = false;
    if (parentIdle) clearTimeout(parentIdle);
    parentIdle = null;
    app.go(session.childId ? 'home' : 'who');
  }

  function renderParent() {
    if (!store.doc) return;
    renderPinResetNotice();
    for (const tab of $$('#psec-nav .psec-tab')) {
      if (tab.dataset.psec === session.section) tab.setAttribute('aria-current', 'true');
      else tab.removeAttribute('aria-current');
    }
    for (const sec of $$('#screen-parent .psec')) sec.hidden = sec.dataset.psec !== session.section;
    if (session.section === 'tasks') renderTasks();
    else if (session.section === 'rewards') renderRewards();
    else if (session.section === 'children') renderChildren();
    else if (session.section === 'settings') renderSettings();
    renderCounts();
  }

  function showSection(name) {
    if (!PARENT_SECTIONS.includes(name)) return;
    if (name !== session.section) {
      closeTaskForm();
      closeChildForm();
      hideRemoveConfirm();
      resetParentForms();
      for (const n of $$('#screen-parent .psec .status')) app.clearStatus(n);
    }
    session.section = name;
    renderParent();
    const h = $('#screen-parent .psec[data-psec="' + name + '"] h2');
    if (h) h.focus();
  }

  /** The small forms of To review, Rewards and Settings, closed. */
  function resetParentForms() {
    session.undoing = null;
    session.ledgerAll = false;
    session.deleting = 0;
    session.copy = null;
    closeRewardForm();
  }

  /** What waits for the parent, after the labels of the sections: tasks to review, rewards to give. */
  function renderCounts() {
    const doc = store.doc;
    const kids = new Set(doc.children.map((c) => c.id));
    const give = doc.tasks.filter((x) => x.rewardStatus === 'unlocked' && kids.has(x.childId)).length;
    setCount($('#psec-count-rewards'), give);
  }

  function setCount(node, n) {
    node.textContent = n ? app.fmtNum(n) : '';
    node.hidden = !n;
  }

  /** The child shown by Tasks and Rewards (one choice for both), or null without children. */
  function parentChildId() {
    const children = store.doc.children;
    if (!children.some((c) => c.id === session.ptChildId)) {
      session.ptChildId = children.some((c) => c.id === session.childId) ? session.childId : children.length ? children[0].id : null;
    }
    return session.ptChildId;
  }

  function fillChildSelect(select) {
    select.textContent = '';
    for (const c of store.doc.children) select.append(el('option', { value: c.id }, c.avatar + ' ' + c.nickname));
    if (session.ptChildId) select.value = session.ptChildId;
  }

  function childName(childId) {
    const c = store.doc.children.find((x) => x.id === childId);
    return { user: c ? c.nickname : '' };
  }

  function kindIcon(kind) {
    return el('span', { class: 'kind-icon kind-' + kind }, svgIcon(KIND_ICONS[kind]));
  }

  // --- Results of a task, for the parent ---------------------------------------

  function isMeaningTask(task) {
    return task.kind === 'recite' && task.mode === 'contextual';
  }

  /** The figures of the attempts: best and last result, tries, passes, when it became ready. */
  function statList(task, stats, opts) {
    const o = opts || {};
    const items = [];
    if (isMeaningTask(task)) {
      const last = task.attempts.length ? task.attempts[task.attempts.length - 1] : null;
      if (last && last.verdict) items.push(t('fam_review_last', { pct: t('fam_res_' + (last.verdict === 'same_meaning' || last.verdict === 'partly' || last.verdict === 'different' ? last.verdict : 'unclear')) }));
    } else {
      if (stats.bestAccuracy !== null) items.push(t('fam_review_best', { pct: fmtPct(stats.bestAccuracy) }));
      if (stats.lastAccuracy !== null) items.push(t('fam_review_last', { pct: fmtPct(stats.lastAccuracy) }));
    }
    items.push(t('fam_review_attempts', { n: stats.attemptCount }));
    if (o.passed && stats.passedCount) items.push(t('fam_review_passed', { n: stats.passedCount }));
    if (task.status === 'ready' && task.readyAt) items.push(t('fam_review_ready_at', { when: fmtDate(task.readyAt, true) }));
    return el('ul', { class: 'stat-list' }, items.map((x) => el('li', null, x)));
  }

  /** "N more words right in the last try than before", only when it is true. */
  function improvementLine(n) {
    if (n === null || n === undefined || n <= 0) return null;
    return el('p', { class: 'improve' }, tNodes(n === 1 ? 'fam_review_improve_one' : 'fam_review_improve', { n }));
  }

  function sectionStatus(where) {
    return where === 'rewards' ? $('#prw-status') : $('#pt-status');
  }

  /** After an action in a list that was drawn again: focus where the parent was. */
  function refocus(where, taskId) {
    const target = where === 'rewards' ? $('#prw-history-h') : $('#pt-list [data-details="' + taskId + '"]') || $('#psec-tasks-h');
    if (target) target.focus();
  }

  /** (Redesign) The parent takes back the stars of a done task: it is to do again. */
  function undoNow(taskId, where) {
    session.undoing = null;
    let task;
    try {
      update((d, now) => R.undoTask(d, taskId, now));
      task = R.getTask(store.doc, taskId);
    } catch (err) {
      renderParent();
      app.setStatus(sectionStatus(where), 'error_generic', null, { error: true });
      return;
    }
    renderParent();
    say(sectionStatus(where), [['fam_undone']]);
    refocus(where, task.id);
  }

  /** "Take the stars back", asked in place first (the reward is locked again too). */
  function undoControls(task, where) {
    if (session.undoing && session.undoing.taskId === task.id && session.undoing.where === where) {
      const yes = el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', 'data-undo-yes': task.id }, t('fam_undo'));
      yes.addEventListener('click', () => undoNow(task.id, where));
      const no = el('button', { type: 'button', class: 'btn btn-small', 'data-undo-no': task.id }, t('fam_keep'));
      no.addEventListener('click', () => {
        session.undoing = null;
        renderParent();
        const again = $('#screen-parent [data-undo="' + task.id + '"]');
        if (again) again.focus();
      });
      return el('div', { class: 'ptask-actions inline-confirm', role: 'group' }, [el('p', null, t('fam_undo_q')), yes, no]);
    }
    const b = el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', 'data-undo': task.id }, t('fam_undo'));
    b.addEventListener('click', () => {
      session.undoing = { taskId: task.id, where };
      renderParent();
      const yes = $('#screen-parent [data-undo-yes="' + task.id + '"]');
      if (yes) yes.focus();
    });
    return b;
  }

  /** "Mark as done" ('parent_override', a task to do): its stars go into the jar. */
  function confirmNow(taskId, how, where) {
    let task;
    try {
      update((d, now) => R.confirmTask(d, taskId, how, now));
      task = R.getTask(store.doc, taskId);
    } catch (err) {
      renderParent();
      app.setStatus(sectionStatus(where), 'error_generic', null, { error: true });
      return;
    }
    renderParent();
    const parts = [['fam_confirmed_for', { stars: starsText(task.stars), name: childName(task.childId) }]];
    if (task.reward) parts.push(['fam_reward_to_give', { reward: { user: rewardLabel(task.reward) } }]);
    say(sectionStatus(where), parts);
    refocus(where, taskId);
  }

  /** A task reward the child has received ('unlocked' -> 'given'). */
  function markGiven(taskId, where) {
    let task;
    try {
      update((d, now) => R.markRewardGiven(d, taskId, now));
      task = R.getTask(store.doc, taskId);
    } catch (err) {
      renderParent();
      app.setStatus(sectionStatus(where), 'error_generic', null, { error: true });
      return;
    }
    renderParent();
    say(sectionStatus(where), [['fam_marked_given', { reward: { user: rewardLabel(task.reward) } }]]);
    refocus(where, taskId);
  }

  // --- The details of a task (Tasks): figures, text, and "Confirm anyway" -------

  function toggleDetail(taskId) {
    session.detailTaskId = session.detailTaskId === taskId ? null : taskId;
    renderTasks();
    const b = $('#pt-list [data-details="' + taskId + '"]');
    if (b) b.focus();
  }

  function taskDetail(task) {
    const stats = R.taskStats(task);
    const box = el('div', { class: 'ptask-detail', id: 'ptd-' + task.id });
    const dates = [t('fam_detail_created', { date: fmtDate(task.createdAt) })];
    if (task.due) dates.push(t('fam_detail_due', { date: fmtDay(task.due) }));
    if (task.sentBackAt) dates.push(t('fam_detail_sent_back', { date: fmtDate(task.sentBackAt) }));
    if (task.doneAt) dates.push(t('fam_detail_done', { date: fmtDate(task.doneAt) }));
    box.append(el('ul', { class: 'stat-list' }, dates.map((x) => el('li', null, x))));
    if (task.kind === 'quran') {
      const q = task.quran;
      const info = surahInfo(q.surah);
      const name = info ? (app.uiLang() !== 'ar' && info.name_translit ? info.name_translit : info.name_ar) : null;
      box.append(el('p', { class: 'detail-line' }, [
        t('surah') + ' ' + app.fmtNum(q.surah) + (name ? ' ' : ''),
        name ? el('bdi', null, name) : null,
        ' · ' + t('fam_detail_quran', { from: q.from, to: q.to }) + ' · ' + t(q.memory ? 'mode_memory' : 'mode_looking'),
      ]));
      if (!surahsCache) loadSurahsFor(task.id);
    } else {
      box.append(el('div', { class: 'detail-text', lang: task.lang, dir: app.dirOf(task.lang), tabindex: '0', role: 'region', 'aria-label': t('fam_tf_text') }, task.text));
      if (task.kind === 'recite') box.append(el('p', { class: 'hint detail-line' }, t('fam_detail_mode', { mode: t(isMeaningTask(task) ? 'mode_contextual' : 'mode_strict') })));
      // The Quran parts of the text (and differences kept as typed), from the server;
      // filled in place when the answer comes (the focus stays where it is).
      const holder = el('div', { class: 'detail-quran' });
      box.append(holder);
      const info = textInfoFor(task, () => {
        const later = document.querySelector('#ptd-' + task.id + ' .detail-quran');
        if (later) fillDetailQuran(later, task, textInfoFor(task));
      });
      if (info) fillDetailQuran(holder, task, info);
    }
    if (stats.attemptCount) {
      box.append(statList(task, stats, { passed: true }));
      const imp = improvementLine(stats.improvement);
      if (imp) box.append(imp);
    } else {
      box.append(el('p', { class: 'hint detail-line' }, t('fam_detail_no_try')));
    }
    if (task.sentBackNote && task.status === 'assigned') box.append(el('p', { class: 'task-note' }, [t('fam_note_label') + ' ', userText(task.sentBackNote)]));
    if (task.status === 'assigned') box.append(el('p', { class: 'hint-parent' }, t(task.kind === 'dictation' ? 'fam_detail_anyway_dictation' : 'fam_mark_done_hint')));
    if (task.confirmedBy) box.append(el('p', { class: 'detail-line' }, t(task.confirmedBy === 'app_pass' ? 'fam_detail_by_app' : 'fam_detail_by_parent')));
    if (task.reward) box.append(el('p', { class: 'detail-line' }, [el('span', { 'aria-hidden': 'true' }, task.reward.emoji + ' '), t('fam_rs_' + (task.rewardStatus === 'none' ? 'locked' : task.rewardStatus))]));
    const actions = R.taskActions(task);
    if (actions.markRewardGiven) {
      const b = el('button', { type: 'button', class: 'btn btn-small', 'data-given': task.id }, t('fam_mark_given'));
      b.addEventListener('click', () => markGiven(task.id, 'detail'));
      box.append(el('div', { class: 'ptask-actions' }, b));
    }
    return box;
  }

  /**
   * The Quran parts of a task's text in its details (UX-17) and, for a task by meaning
   * whose text has Quran words, which cannot be done (RL-6), "Recite word by word".
   */
  function fillDetailQuran(holder, task, info) {
    holder.textContent = '';
    if (!info) return;
    if (info.parts.length) {
      const qbox = el('div', { class: 'quran-parts' });
      app.renderQuranParts(qbox, info, { lang: task.lang, note: false });
      holder.append(qbox);
    }
    if (isMeaningTask(task) && !info.contextual && R.taskActions(task).edit) {
      const fix = el('button', { type: 'button', class: 'btn btn-primary btn-small', 'data-word-by-word': task.id }, t('fam_make_word_by_word'));
      fix.addEventListener('click', () => makeWordByWord(task.id));
      holder.append(el('p', { class: 'hint-parent' }, t('fam_detail_meaning_quran')), el('div', { class: 'ptask-actions' }, fix));
    }
  }

  /** A task by meaning whose text has Quran words becomes a word-by-word task (RL-6). */
  function makeWordByWord(taskId) {
    try {
      update((d, now) => R.updateTask(d, taskId, { mode: 'strict' }, now));
    } catch (err) {
      app.setStatus($('#pt-status'), 'error_generic', null, { error: true });
      return;
    }
    renderParent();
    app.setStatus($('#pt-status'), 'fam_task_word_by_word');
    const details = $('#pt-list [data-details="' + taskId + '"]');
    if (details) details.focus();
  }

  /** The surah names, for the details of a Quran task (the number is shown until then). */
  async function loadSurahsFor(taskId) {
    try {
      surahsCache = await app.loadSurahs();
    } catch (err) {
      return;
    }
    if (session.detailTaskId === taskId && session.section === 'tasks' && app.screen() === 'parent') renderTasks();
  }

  // --- Rewards, per child: jar and history, rewards to give, goals, surprises, corrections

  function renderRewards() {
    const doc = store.doc;
    const id = parentChildId();
    fillChildSelect($('#prw-child'));
    const none = !id;
    $('#prw-child-field').hidden = none;
    $('#prw-nochild').hidden = !none;
    $('#prw-body').hidden = none;
    if (session.rwForm && session.rwForm.childId !== id) closeRewardForm();
    if (none) return;
    const sum = R.childSummary(doc, id);
    const jar = R.getJar(doc, id) || { goals: [], ledger: [] };
    setNodes($('#prw-balance'), 'fam_jar', { n: sum.balance });
    setNodes($('#prw-earned'), 'fam_rw_earned', { n: sum.earned });

    // Task rewards unlocked and not given yet.
    const give = $('#prw-give-list');
    give.textContent = '';
    for (const task of sum.rewardsToGive) give.append(rewardToGiveItem(task));
    $('#prw-give-empty').hidden = sum.rewardsToGive.length > 0;

    // Goals: the open ones, cheapest first, then the given ones, newest first.
    const goals = $('#prw-goals');
    goals.textContent = '';
    const given = jar.goals.filter((g) => g.status === 'given').sort((a, b) => (a.givenAt < b.givenAt ? 1 : a.givenAt > b.givenAt ? -1 : 0));
    for (const g of sum.goals.concat(given)) goals.append(goalItem(g, sum.balance, id));
    $('#prw-goals-empty').hidden = jar.goals.length > 0;

    // Surprises the child has not seen yet.
    const unseen = $('#prw-unseen');
    if (sum.unseenSurprises.length) {
      const sep = app.uiLang() === 'ar' ? '، ' : ', ';
      setNodes(unseen, 'fam_surprise_unseen', { list: { user: sum.unseenSurprises.map((x) => rewardLabel(x.reward)).join(sep) } });
      unseen.hidden = false;
    } else {
      unseen.textContent = '';
      unseen.hidden = true;
    }

    // The forms (only one is open at a time).
    const f = session.rwForm ? session.rwForm.kind : null;
    $('#gf').hidden = f !== 'goal';
    $('#sf').hidden = f !== 'surprise';
    $('#af').hidden = f !== 'adjust';
    $('#prw-goal-add').hidden = f === 'goal';
    $('#prw-surprise-open').hidden = f === 'surprise';
    $('#prw-adjust-open').hidden = f === 'adjust';

    renderLedger(doc, jar);
  }

  function rewardToGiveItem(task) {
    const nameId = 'rg-' + task.id;
    const b = el('button', { type: 'button', class: 'btn btn-primary btn-small', 'data-given': task.id, 'aria-describedby': nameId }, t('fam_mark_given'));
    b.addEventListener('click', () => markGiven(task.id, 'rewards'));
    return el('li', { class: 'ptask reward-item', 'data-task': task.id }, [
      el('div', { class: 'goal-head' }, [el('span', { class: 'goal-emoji', 'aria-hidden': 'true' }, task.reward.emoji), el('p', { class: 'goal-name', id: nameId }, userText(task.reward.text))]),
      el('p', { class: 'hint' }, tNodes('fam_rw_for_task', { title: { user: task.title } })),
      task.doneAt ? el('p', { class: 'hint' }, t('fam_detail_done', { date: fmtDate(task.doneAt) })) : null,
      el('div', { class: 'ptask-actions' }, b),
    ]);
  }

  function goalItem(goal, balance, childId) {
    const given = goal.status === 'given';
    const nameId = 'goal-' + goal.id;
    const lines = [el('div', { class: 'goal-head' }, [el('span', { class: 'goal-emoji', 'aria-hidden': 'true' }, goal.reward.emoji), el('p', { class: 'goal-name', id: nameId }, userText(goal.reward.text))])];
    const meta = [t('fam_goal_cost', { n: goal.cost })];
    if (given) meta.push(t('fam_goal_given_on', { date: fmtDate(goal.givenAt) }));
    lines.push(el('p', { class: 'hint' }, meta.join(' · ')));
    const buttons = [];
    if (!given) {
      if (balance >= goal.cost) {
        lines.push(el('p', { class: 'goal-enough' }, t('fam_goal_enough')));
        const b = el('button', { type: 'button', class: 'btn btn-primary btn-small', 'data-give-goal': goal.id, 'aria-describedby': nameId }, t('fam_goal_give'));
        b.addEventListener('click', () => giveGoalNow(childId, goal.id));
        buttons.push(b);
      } else {
        lines.push(el('p', { class: 'hint' }, t('fam_goal_short', { n: goal.cost - balance })));
      }
    }
    const rm = el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', 'data-remove-goal': goal.id, 'aria-describedby': nameId }, t('fam_remove'));
    rm.addEventListener('click', () => {
      session.removingGoal = goal.id; // asked in place first: a removal cannot be undone
      renderRewards();
      const yes = $('#prw-goals [data-remove-goal-yes="' + goal.id + '"]');
      if (yes) yes.focus();
    });
    buttons.push(rm);
    if (session.removingGoal === goal.id) {
      const yes = el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', 'data-remove-goal-yes': goal.id }, t('fam_remove'));
      yes.addEventListener('click', () => {
        session.removingGoal = null;
        removeGoalNow(childId, goal.id);
      });
      const no = el('button', { type: 'button', class: 'btn btn-small', 'data-remove-goal-no': goal.id }, t('fam_keep'));
      no.addEventListener('click', () => {
        session.removingGoal = null;
        renderRewards();
        const again = $('#prw-goals [data-remove-goal="' + goal.id + '"]');
        if (again) again.focus();
      });
      lines.push(el('div', { class: 'ptask-actions inline-confirm', role: 'group' }, [el('p', null, t('fam_goal_remove_q')), yes, no]));
    } else {
      lines.push(el('div', { class: 'ptask-actions' }, buttons));
    }
    return el('li', { class: 'ptask goal-item' + (given ? ' is-given' : ''), 'data-goal': goal.id }, lines);
  }

  function giveGoalNow(childId, goalId) {
    const status = $('#prw-status');
    const goal = (R.getJar(store.doc, childId) || { goals: [] }).goals.find((g) => g.id === goalId);
    try {
      update((d, now) => R.giveGoal(d, childId, goalId, now));
    } catch (err) {
      renderRewards();
      renderCounts();
      app.setStatus(status, isRewardsError(err, 'insufficient_stars') ? 'fam_err_not_enough' : 'error_generic', null, { error: true });
      return;
    }
    renderRewards();
    say(status, [['fam_goal_given_now', { reward: { user: rewardLabel(goal.reward) }, n: R.getJar(store.doc, childId).balance }]]);
    $('#prw-goals-h').focus();
  }

  function removeGoalNow(childId, goalId) {
    try {
      update((d, now) => R.removeGoal(d, childId, goalId, now));
    } catch (err) {
      renderRewards();
      app.setStatus($('#prw-status'), 'error_generic', null, { error: true });
      return;
    }
    renderRewards();
    app.setStatus($('#prw-status'), 'fam_goal_removed');
    $('#prw-goals-h').focus();
  }

  /** The history of the stars, newest first: the last entries, or all of them. */
  function renderLedger(doc, jar) {
    const list = $('#prw-ledger');
    list.textContent = '';
    const entries = jar.ledger.slice().reverse();
    const shown = session.ledgerAll ? entries : entries.slice(0, LEDGER_SHOWN);
    for (const e of shown) {
      const plus = e.delta > 0;
      const delta = el('bdi', { class: 'ledger-delta ' + (plus ? 'is-plus' : 'is-minus'), dir: 'ltr' }, (plus ? '+' : e.delta < 0 ? '−' : '') + app.fmtNum(Math.abs(e.delta)) + ' ' + STAR);
      const item = el('li', null, [delta, el('span', { class: 'ledger-what' }, ledgerWhat(doc, jar, e)), el('span', { class: 'ledger-when' }, fmtDate(e.at))]);
      // (Redesign) The stars a task gave can be taken back here (its latest credit only).
      const task = e.reason === 'task' && e.ref ? doc.tasks.find((x) => x.id === e.ref) : null;
      if (task && task.status === 'done' && latestCredit(jar, task.id) === e) item.append(el('div', { class: 'ledger-undo' }, undoControls(task, 'rewards')));
      list.append(item);
    }
    $('#prw-ledger-empty').hidden = entries.length > 0;
    const more = $('#prw-ledger-more');
    more.hidden = entries.length <= LEDGER_SHOWN;
    more.setAttribute('aria-expanded', session.ledgerAll ? 'true' : 'false');
    more.textContent = session.ledgerAll ? t('fam_show_less') : t('fam_show_all', { n: entries.length });
  }

  /** The newest 'task' entry of a task in the history. */
  function latestCredit(jar, taskId) {
    for (let i = jar.ledger.length - 1; i >= 0; i--) {
      const e = jar.ledger[i];
      if (e.ref === taskId && (e.reason === 'task' || e.reason === 'undo')) return e.reason === 'task' ? e : null;
    }
    return null;
  }

  function ledgerWhat(doc, jar, e) {
    if (e.reason === 'task') {
      const task = doc.tasks.find((x) => x.id === e.ref);
      return task ? tNodes('fam_led_task', { title: { user: task.title } }) : t('fam_led_task_gone');
    }
    if (e.reason === 'undo') {
      const task = doc.tasks.find((x) => x.id === e.ref);
      return task ? tNodes('fam_led_undo', { title: { user: task.title } }) : t('fam_led_undo_gone');
    }
    if (e.reason === 'practice') {
      if (e.act === 'quran') return t('fam_led_practice_quran');
      const x = e.ref ? (doc.texts || []).find((y) => y.id === e.ref) : null;
      return x ? tNodes('fam_led_practice', { title: { user: x.title } }) : t('fam_led_practice_gone');
    }
    if (e.reason === 'goal') {
      const goal = jar.goals.find((g) => g.id === e.ref);
      return goal ? tNodes('fam_led_goal', { reward: { user: rewardLabel(goal.reward) } }) : t('fam_led_goal_gone');
    }
    if (e.reason === 'adjust') return e.note ? tNodes('fam_led_adjust', { note: { user: e.note } }) : t('fam_led_adjust_plain');
    return t('fam_led_carry');
  }

  // The three forms of Rewards: a goal, a surprise, a correction of the stars.

  function openRewardForm(kind) {
    const id = parentChildId();
    if (!id) return;
    session.rwForm = { kind, childId: id };
    app.clearStatus($('#prw-status'));
    if (kind === 'goal') {
      $('#gf-text').value = '';
      $('#gf-cost').value = app.fmtNum(10);
      renderEmojiPick($('#gf-emojis'), R.REWARD_EMOJIS, R.REWARD_EMOJIS[0]);
      app.clearStatus($('#gf-status'));
    } else if (kind === 'surprise') {
      $('#sf-text').value = '';
      renderEmojiPick($('#sf-emojis'), R.REWARD_EMOJIS, R.REWARD_EMOJIS[0]);
      app.clearStatus($('#sf-status'));
    } else {
      setRadio('af-way', 'add');
      $('#af-n').value = '';
      $('#af-note').value = '';
      app.clearStatus($('#af-status'));
    }
    renderRewards();
    const first = { goal: '#gf-h', surprise: '#sf-text', adjust: '#af-n' }[kind];
    $(first).focus();
  }

  function closeRewardForm() {
    session.rwForm = null;
    for (const id of ['#gf', '#sf', '#af']) $(id).hidden = true;
    for (const id of ['#prw-goal-add', '#prw-surprise-open', '#prw-adjust-open']) $(id).hidden = false;
  }

  function cancelRewardForm() {
    const kind = session.rwForm ? session.rwForm.kind : null;
    closeRewardForm();
    renderRewards();
    const opener = { goal: '#prw-goal-add', surprise: '#prw-surprise-open', adjust: '#prw-adjust-open' }[kind];
    if (opener) $(opener).focus();
  }

  function submitGoal() {
    const f = session.rwForm;
    if (!f || f.kind !== 'goal') return;
    const status = $('#gf-status');
    const text = $('#gf-text').value.trim();
    const cost = numberValue('#gf-cost');
    if (!text) return failAt(status, 'fam_err_reward_text', '#gf-text');
    if (!Number.isInteger(cost) || cost < R.LIMITS.goalCostMin || cost > R.LIMITS.goalCostMax) return failAt(status, 'fam_err_cost', '#gf-cost');
    try {
      update((d, now) => R.addGoal(d, f.childId, { cost, reward: { text, emoji: pickedEmoji($('#gf-emojis')) || R.REWARD_EMOJIS[0] } }, now).doc);
    } catch (err) {
      const field = isRewardsError(err, 'bad_input') ? String(err.field || '') : '';
      if (field === 'cost') return failAt(status, 'fam_err_cost', '#gf-cost');
      if (field.startsWith('reward')) return failAt(status, 'fam_err_reward_text', '#gf-text');
      return failAt(status, 'error_generic');
    }
    closeRewardForm();
    renderRewards();
    app.setStatus($('#prw-status'), 'fam_goal_added');
    $('#prw-goal-add').focus();
  }

  function submitSurprise() {
    const f = session.rwForm;
    if (!f || f.kind !== 'surprise') return;
    const status = $('#sf-status');
    const text = $('#sf-text').value.trim();
    if (!text) return failAt(status, 'fam_err_surprise_text', '#sf-text');
    try {
      update((d, now) => R.addSurprise(d, f.childId, { text, emoji: pickedEmoji($('#sf-emojis')) || R.REWARD_EMOJIS[0] }, now).doc);
    } catch (err) {
      return failAt(status, isRewardsError(err, 'bad_input') ? 'fam_err_surprise_text' : 'error_generic', '#sf-text');
    }
    closeRewardForm();
    renderRewards();
    say($('#prw-status'), [['fam_surprise_done', { name: childName(f.childId) }]]);
    $('#prw-surprise-open').focus();
  }

  function submitAdjust() {
    const f = session.rwForm;
    if (!f || f.kind !== 'adjust') return;
    const status = $('#af-status');
    const n = numberValue('#af-n');
    const note = $('#af-note').value.trim();
    const take = ($('input[name="af-way"]:checked') || {}).value === 'take';
    if (!Number.isInteger(n) || n < 1 || n > R.LIMITS.adjustMax) return failAt(status, 'fam_err_cost', '#af-n');
    if (!note) return failAt(status, 'fam_err_note', '#af-note');
    const before = R.getJar(store.doc, f.childId).balance;
    try {
      update((d, now) => R.adjustStars(d, f.childId, take ? -n : n, now, note));
    } catch (err) {
      if (isRewardsError(err, 'insufficient_stars')) return failAt(status, 'fam_err_no_stars', '#af-n');
      const field = isRewardsError(err, 'bad_input') ? err.field : '';
      if (field === 'note') return failAt(status, 'fam_err_note', '#af-note');
      if (field === 'delta') return failAt(status, 'fam_err_cost', '#af-n');
      return failAt(status, 'error_generic');
    }
    const after = R.getJar(store.doc, f.childId).balance;
    closeRewardForm();
    renderRewards();
    const parts = [];
    if (take && before - after < n) parts.push(['fam_adjust_limited']); // never below zero
    parts.push(['fam_adjust_done', { n: after }]);
    say($('#prw-status'), parts);
    $('#prw-adjust-open').focus();
  }

  function failAt(status, key, focusSel) {
    app.setStatus(status, key, null, { error: true });
    if (focusSel) $(focusSel).focus();
  }

  // --- Settings: consent, the PIN, the parent's language, delete all data -------

  function renderSettings() {
    $('#settings-consent').checked = !!store.doc.parent.consentAt;
    // The AI box (shown by app.js only while Claude is set up) needs the general consent.
    $('#settings-ai-consent').checked = R.hasAiConsent(store.doc);
    $('#settings-ai-consent').disabled = !store.doc.parent.consentAt;
    $('#ps-lang').value = store.doc.parent.uiLang;
    $('#ps-delete').hidden = session.deleting > 0;
    $('#ps-delete-1').hidden = session.deleting !== 1;
    $('#ps-delete-2').hidden = session.deleting !== 2;
    $('#ps-copy-confirm').hidden = !session.copy;
    if (session.copy) renderCopySummary('ps-copy', session.copy);
  }

  /**
   * The general consent. Ticked: the microphone and camera, never Claude (that is the box
   * under the Claude notice). Unticked: both consents are withdrawn, as before.
   */
  function onSettingsConsent(e) {
    const on = e.target.checked;
    try {
      update((d, now) => R.updateParent(d, { consent: on }, now));
    } catch (err) {
      e.target.checked = !on;
      return;
    }
    syncApp();
    renderSettings();
  }

  /** The AI consent, from its own box under the Claude notice (shown only with Claude). */
  function onSettingsAiConsent(e) {
    const on = e.target.checked;
    try {
      if (on && !claudeSetUp()) throw new Error('the Claude notice is not shown');
      update((d, now) => R.updateParent(d, { aiConsent: on }, now));
    } catch (err) {
      e.target.checked = !on;
      return;
    }
    syncApp();
    renderSettings();
  }

  /** Change the PIN: the current one, then the new one twice (the PIN dialog). */
  async function changePin() {
    const status = $('#ps-pin-status');
    app.clearStatus(status);
    const ok = await pinDialog('change');
    if (!store.doc || app.screen() !== 'parent') return;
    if (ok) app.setStatus(status, 'fam_pin_changed');
    $('#ps-pin-change').focus();
  }

  /** The language of the parent area (and of the PIN dialog); each child keeps their own. */
  function onParentLang(e) {
    const lang = e.target.value;
    if (!R.LANGS.includes(lang) || !store.doc) return;
    try {
      update((d, now) => R.updateParent(d, { uiLang: lang }, now));
    } catch (err) {
      e.target.value = store.doc.parent.uiLang;
      return;
    }
    // Statuses written in the old language go; the area is drawn again in the new one.
    for (const n of $$('#screen-parent .status')) app.clearStatus(n);
    app.setUiLang(lang);
    app.setStatus($('#ps-lang-status'), 'fam_set_lang_saved');
  }

  /** "Delete all data on this device", confirmed twice: step 0 (none), 1, 2. */
  function askDelete(step) {
    session.deleting = step;
    app.clearStatus($('#ps-delete-status'));
    renderSettings();
    const target = step === 1 ? $('#ps-delete-1') : step === 2 ? $('#ps-delete-2') : $('#ps-delete');
    target.focus();
  }

  /**
   * Remove the family document, an old v1 profile and every copy kept aside, then start
   * again as on the first day. Nothing else of the app is stored.
   */
  function deleteAllData() {
    if (session.deleting !== 2 || !store.doc) return;
    const ls = storage();
    if (ls) {
      try {
        const keys = [];
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (k === R.STORAGE_KEY || k === R.V1_KEY || (k && k.startsWith(R.CORRUPT_KEY_PREFIX))) keys.push(k);
        }
        for (const k of keys) ls.removeItem(k);
        if (ls.getItem(R.STORAGE_KEY) !== null) throw new Error('still stored');
      } catch (err) {
        session.deleting = 0;
        renderSettings();
        app.setStatus($('#ps-delete-status'), 'fam_delete_failed', null, { error: true });
        return;
      }
    }
    forgetFamily();
    notice('fam_notice_deleted');
  }

  // --- A copy of the family list: Settings (save, load) and the setup (load) ----

  const COPY_ERRORS = {
    not_copy: 'fam_copy_err_not_copy',
    damaged: 'fam_copy_err_damaged',
    too_big: 'fam_copy_err_too_big',
    newer_version: 'fam_copy_err_newer',
    empty: 'fam_copy_err_empty',
    unreadable: 'fam_copy_err_read',
  };

  /** mommy-family-YYYY-MM-DD.json, with the date of the day on this device. */
  function copyFileName(date) {
    const two = (n) => String(n).padStart(2, '0');
    return `mommy-family-${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}.json`;
  }

  /**
   * "Save a copy": the family list as a JSON file, made in this browser and handed to it
   * through a Blob URL and <a download> (no other origin; the CSP allows it). Without the
   * PIN record and the consents (rewards.js makeFamilyCopy).
   */
  function saveCopy() {
    const status = $('#ps-copy-status');
    app.clearStatus(status);
    try {
      // The newest saved document: another tab may have saved since this one read it.
      if (adoptStored()) setTimeout(() => store.doc && afterExternalChange(), 0);
    } catch (err) {
      return; // deleted in another tab: back to the setup
    }
    if (!store.doc) return;
    // A copy without a child could not be loaded (readFamilyCopy: 'empty').
    if (!store.doc.children.length) {
      app.setStatus(status, 'fam_copy_err_save_empty', null, { error: true });
      return;
    }
    let name;
    try {
      const blob = new Blob([JSON.stringify(R.makeFamilyCopy(store.doc, nowIso()))], { type: 'application/json' });
      if (blob.size > R.FAMILY_COPY.maxBytes) {
        app.setStatus(status, 'fam_copy_err_save_big', null, { error: true }); // it could not be loaded again
        return;
      }
      name = copyFileName(new Date());
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name, hidden: true });
      document.body.append(a);
      a.click();
      a.remove();
      // Some browsers read the URL after the click returns: it is freed a little later.
      setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    } catch (err) {
      app.setStatus(status, 'fam_copy_err_save', null, { error: true });
      return;
    }
    say(status, [['fam_copy_saved', { name: { user: name } }]]);
  }

  function fileText(file) {
    if (typeof file.text === 'function') return file.text();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(file, 'utf-8');
    });
  }

  /**
   * The copy chosen in a file input, read in this browser (nothing is sent): the answer
   * of rewards.js readFamilyCopy, {ok: false, error: 'too_big'} before a big file is
   * read, 'unreadable' when the browser cannot read it, or null without a file.
   */
  async function readCopyFile(input) {
    const file = input.files && input.files[0];
    input.value = ''; // the same file can be chosen again
    if (!file) return null;
    if (file.size > R.FAMILY_COPY.maxBytes) return { ok: false, error: 'too_big' };
    let text;
    try {
      text = await fileText(file);
    } catch (err) {
      return { ok: false, error: 'unreadable' };
    }
    return R.readFamilyCopy(text);
  }

  /**
   * What a copy holds, for the grown-up to see before it is used: when it was saved, the
   * number of children, each child (picture, name, tasks, stars), and whether parts of
   * it were repaired. `prefix` names the nodes (setup-copy, ps-copy).
   */
  function renderCopySummary(prefix, copy) {
    const lang = app.uiLang();
    const s = R.familySummary(copy.family);
    const title = $('#' + prefix + '-title');
    if (copy.savedAt) setNodes(title, 'fam_copy_summary_title', { date: fmtDate(copy.savedAt, true, lang) }, lang);
    else setNodes(title, 'fam_copy_summary_title_nodate', null, lang);
    setNodes($('#' + prefix + '-count'), 'fam_copy_children', { n: s.children.length }, lang);
    const list = $('#' + prefix + '-children');
    list.textContent = '';
    for (const c of s.children) {
      list.append(el('li', null, [
        el('span', { class: 'copy-avatar', 'aria-hidden': 'true' }, c.avatar),
        ' ',
        tNodes('fam_copy_child_line', { name: { user: c.nickname }, tasks: c.tasks, stars: c.stars }, lang),
      ]));
    }
    $('#' + prefix + '-repaired').hidden = !copy.repairs.length;
  }

  /** "Load a copy" in Settings: read the file, then show what it holds and ask. */
  async function onSettingsCopyFile(e) {
    const status = $('#ps-copy-status');
    app.clearStatus(status);
    session.copy = null;
    renderSettings();
    const res = await readCopyFile(e.target);
    if (!res || !store.doc || app.screen() !== 'parent' || session.section !== 'settings') return;
    if (!res.ok) {
      app.setStatus(status, COPY_ERRORS[res.error] || COPY_ERRORS.damaged, null, { error: true });
      return;
    }
    session.copy = res;
    renderSettings();
    $('#ps-copy-confirm').focus();
  }

  function cancelCopy() {
    session.copy = null;
    renderSettings();
    $('#ps-copy-file').focus();
  }

  /**
   * "Replace": this device's family list becomes the copy's; the PIN, its backoff, the
   * consents and the parent's language of this device stay (rewards.js useFamilyCopy).
   * Another tab gets the storage event and draws its screen again.
   */
  function replaceWithCopy() {
    const copy = session.copy;
    if (!copy || !store.doc) return;
    const status = $('#ps-copy-status');
    session.copy = null;
    let res;
    try {
      res = updateSaved((d, now) => R.useFamilyCopy(d, copy.family, now));
    } catch (err) {
      if (!store.doc) return; // deleted in another tab: the setup shows
      renderSettings();
      app.setStatus(status, 'error_generic', null, { error: true });
      return;
    }
    // Not stored (the storage is full): this tab keeps the list that is stored, so that
    // nothing that would be lost at the next load is shown as done (B-R2), and the
    // question stays open. Without any storage (store.memoryOnly) the whole session runs
    // in memory, with its notice, and the copy is used like any other change.
    if (!res.saved && !store.memoryOnly) {
      store.doc = res.before;
      session.copy = copy;
      renderSettings();
      app.setStatus(status, 'fam_copy_err_full', null, { error: true });
      $('#ps-copy-confirm').focus();
      return;
    }
    // The children of this device may be gone: the choices that pointed at them go too.
    if (session.childId && !store.doc.children.some((c) => c.id === session.childId)) session.childId = null;
    session.ptChildId = null;
    session.detailTaskId = null;
    syncApp();
    renderParent();
    app.setStatus(status, 'fam_copy_loaded');
    $('#ps-copy-h').focus();
  }

  // --- Children: add, edit, remove (with a confirmation) ---------------------

  function ageLabel(age) {
    return t(age === '10-13' ? 'age_10_13' : age === '14-18' ? 'age_14_18' : 'age_6_9');
  }

  function renderChildren() {
    const list = $('#pc-list');
    list.textContent = '';
    for (const c of store.doc.children) {
      const edit = el('button', { type: 'button', class: 'btn btn-small', 'data-edit': c.id }, t('fam_edit'));
      edit.addEventListener('click', () => openChildForm(c.id));
      const remove = el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', 'data-remove': c.id }, t('fam_remove'));
      remove.addEventListener('click', () => askRemove(c.id));
      list.append(el('li', { class: 'pchild', 'data-child': c.id }, [
        el('span', { class: 'pchild-avatar', 'aria-hidden': 'true' }, c.avatar),
        el('div', { class: 'pchild-text' }, [
          el('p', { class: 'pchild-name' }, userText(c.nickname)),
          el('p', { class: 'hint pchild-meta' }, ageLabel(c.age) + ' · ' + LANG_NAMES[c.lang]),
        ]),
        el('div', { class: 'pchild-actions' }, [edit, remove]),
      ]));
    }
  }

  function openChildForm(childId) {
    hideRemoveConfirm();
    const c = childId ? store.doc.children.find((x) => x.id === childId) : null;
    session.childForm = { id: c ? c.id : null };
    app.setT($('#cf-h'), c ? 'fam_child_edit_title' : 'fam_child_new_title');
    $('#cf-nick').value = c ? c.nickname : '';
    $('#cf-age').value = c ? c.age : '6-9';
    $('#cf-lang').value = c ? c.lang : parentLang();
    const used = new Set(store.doc.children.map((x) => x.avatar));
    const avatar = c ? c.avatar : R.AVATARS.find((a) => !used.has(a)) || R.AVATARS[0];
    renderEmojiPick($('#cf-avatars'), R.AVATARS, avatar);
    app.clearStatus($('#cf-status'));
    $('#cf').hidden = false;
    $('#pc-add').hidden = true;
    $('#cf-h').focus();
  }

  function closeChildForm() {
    session.childForm = null;
    $('#cf').hidden = true;
    $('#pc-add').hidden = false;
  }

  function submitChildForm() {
    const f = session.childForm;
    if (!f) return;
    const status = $('#cf-status');
    const input = { nickname: $('#cf-nick').value.trim(), age: $('#cf-age').value, lang: $('#cf-lang').value, avatar: pickedEmoji($('#cf-avatars')) };
    if (!input.nickname) {
      app.setStatus(status, 'fam_err_nickname', null, { error: true });
      $('#cf-nick').focus();
      return;
    }
    try {
      if (f.id) update((d, now) => R.updateChild(d, f.id, input, now));
      else update((d, now) => R.addChild(d, input, now).doc);
    } catch (err) {
      app.setStatus(status, isRewardsError(err, 'bad_input') && err.field === 'nickname' ? 'fam_err_nickname' : 'error_generic', null, { error: true });
      return;
    }
    closeChildForm();
    syncApp();
    renderChildren();
    app.setStatus($('#pc-status'), 'fam_child_saved');
    $('#pc-add').focus();
  }

  function askRemove(childId) {
    const c = store.doc.children.find((x) => x.id === childId);
    if (!c) return;
    closeChildForm();
    session.removing = childId;
    const box = $('#pc-remove');
    setNodes($('#pc-remove-text'), 'fam_child_remove_q', { name: { user: c.nickname } });
    box.hidden = false;
    box.setAttribute('tabindex', '-1');
    box.focus();
  }

  function hideRemoveConfirm() {
    session.removing = null;
    $('#pc-remove').hidden = true;
  }

  function confirmRemove() {
    const id = session.removing;
    hideRemoveConfirm();
    if (!id) return;
    try {
      update((d, now) => R.removeChild(d, id, now));
    } catch (err) {
      app.setStatus($('#pc-status'), 'error_generic', null, { error: true });
      return;
    }
    if (session.childId === id) session.childId = null;
    if (session.ptChildId === id) session.ptChildId = null;
    syncApp();
    renderChildren();
    app.setStatus($('#pc-status'), 'fam_child_removed');
    $('#pc-add').focus();
  }

  // --- Tasks: per child, create, edit, archive -------------------------------

  function renderTasks() {
    const doc = store.doc;
    parentChildId();
    fillChildSelect($('#pt-child'));
    const none = !session.ptChildId;
    $('#pt-child-field').hidden = none;
    $('#pt-nochild').hidden = !none;
    $('#pt-new').hidden = none || !!session.taskForm;
    const list = $('#pt-list');
    list.textContent = '';
    if (none) {
      $('#pt-empty').hidden = true;
      $('#pt-archived').hidden = true;
      return;
    }
    const order = { assigned: 0, done: 2 };
    const tasks = doc.tasks.filter((x) => x.childId === session.ptChildId);
    const shown = tasks.filter((x) => x.status !== 'archived').sort((a, b) => order[a.status] - order[b.status] || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    for (const task of shown) list.append(parentTaskItem(task));
    $('#pt-empty').hidden = shown.length > 0;
    const archived = tasks.length - shown.length;
    const arch = $('#pt-archived');
    if (archived) app.setT(arch, 'fam_tasks_archived', { n: archived });
    else app.setT(arch, null);
    arch.hidden = !archived;
  }

  /**
   * What the server said about the text of a task, in mode strict ({parts, mushafText,
   * text, contextual}), kept for the session (filled when a task is saved, else asked
   * once): the details, the edit form and the child's home show the Quran parts from it.
   * null while it is not known; `then` runs when the answer arrives.
   */
  const textInfo = new Map();

  function textInfoKey(text, lang) {
    return lang + '\n' + text;
  }

  function rememberTextInfo(text, lang, res, contextual) {
    textInfo.set(textInfoKey(text, lang), { parts: res.quranParts, mushafText: res.mushafText, text, contextual });
  }

  function textInfoFor(task, then) {
    if (!task || task.kind === 'quran' || !task.text) return null;
    const key = textInfoKey(task.text, task.lang);
    const known = textInfo.get(key);
    if (known && known !== 'pending') return known;
    if (!known) {
      textInfo.set(key, 'pending');
      app.checkText(task.text, task.lang, 'strict').then((res) => {
        rememberTextInfo(task.text, task.lang, res, res.contextual);
        if (then) then();
      }).catch(() => textInfo.delete(key)); // asked again next time
    }
    return null;
  }

  function parentTaskItem(task) {
    const actions = R.taskActions(task);
    const open = session.detailTaskId === task.id;
    const details = el('button', { type: 'button', class: 'btn btn-small', 'data-details': task.id, 'aria-expanded': open ? 'true' : 'false', 'aria-controls': open ? 'ptd-' + task.id : null }, t('fam_details'));
    details.addEventListener('click', () => toggleDetail(task.id));
    const buttons = [details];
    if (actions.edit) {
      const b = el('button', { type: 'button', class: 'btn btn-small', 'data-edit-task': task.id }, t('fam_edit'));
      b.addEventListener('click', () => openTaskForm(task.id));
      buttons.push(b);
    }
    if (actions.archive) {
      const b = el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', 'data-archive-task': task.id }, t('fam_archive'));
      b.addEventListener('click', () => {
        session.archiving = task.id; // asked in place first: an archive cannot be undone
        renderTasks();
        const yes = $('#pt-list [data-archive-yes="' + task.id + '"]');
        if (yes) yes.focus();
      });
      buttons.push(b);
    }
    if (actions.confirmAnyway) {
      const b = el('button', { type: 'button', class: 'btn btn-small', 'data-confirm-anyway': task.id }, t('fam_mark_done'));
      b.addEventListener('click', () => confirmNow(task.id, 'parent_override', 'tasks'));
      buttons.push(b);
    }
    const undoing = task.status === 'done' && session.undoing && session.undoing.taskId === task.id && session.undoing.where === 'tasks';
    if (task.status === 'done' && !undoing) buttons.push(undoControls(task, 'tasks'));
    let actionRow = el('div', { class: 'ptask-actions' }, buttons);
    if (undoing) actionRow = undoControls(task, 'tasks');
    if (actions.archive && session.archiving === task.id) {
      const yes = el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', 'data-archive-yes': task.id }, t('fam_archive'));
      yes.addEventListener('click', () => archive(task.id));
      const no = el('button', { type: 'button', class: 'btn btn-small', 'data-archive-no': task.id }, t('fam_keep'));
      no.addEventListener('click', () => {
        session.archiving = null;
        renderTasks();
        const again = $('#pt-list [data-archive-task="' + task.id + '"]');
        if (again) again.focus();
      });
      actionRow = el('div', { class: 'ptask-actions inline-confirm', role: 'group' }, [el('p', null, t('fam_archive_q')), yes, no]);
    }
    return el('li', { class: 'ptask status-' + task.status, 'data-task': task.id }, [
      el('div', { class: 'ptask-head' }, [
        el('span', { class: 'kind-icon kind-' + task.kind }, svgIcon(KIND_ICONS[task.kind])),
        el('p', { class: 'ptask-title' }, userText(task.title)),
      ]),
      el('p', { class: 'hint ptask-meta' }, [
        t('fam_kind_' + task.kind) + ' · ' + t('fam_status_' + task.status) + ' · ',
        el('span', { 'aria-hidden': 'true' }, starsText(task.stars)),
        el('span', { class: 'sr-only' }, t('fam_stars_n', { n: task.stars })),
        task.reward ? ' · ' : null,
        task.reward ? el('span', { 'aria-hidden': 'true' }, task.reward.emoji + ' ') : null,
        task.reward ? userText(task.reward.text) : null,
      ]),
      actionRow,
      open ? taskDetail(task) : null,
    ]);
  }

  function archive(taskId) {
    session.archiving = null;
    try {
      update((d, now) => R.archiveTask(d, taskId, now));
    } catch (err) {
      app.setStatus($('#pt-status'), 'error_generic', null, { error: true });
      return;
    }
    if (session.taskForm && session.taskForm.id === taskId) closeTaskForm();
    renderParent();
    app.setStatus($('#pt-status'), 'fam_task_archived');
    $('#pt-new').focus();
  }

  function formKind() {
    const r = $('input[name="tf-kind"]:checked');
    return r ? r.value : 'recite';
  }

  function formMode() {
    const r = $('input[name="tf-mode"]:checked');
    return r && r.value === 'contextual' ? 'contextual' : 'strict';
  }

  /**
   * The Quran parts of the form's text, as the server found them (a check or a page
   * read), shown under the text; null hides them. `resubmit`: "Use the mushaf text" also
   * saves again (the parent had pressed "Save"). A text with Quran parts is recited word
   * by word only, so "The meaning" is disabled with the reason.
   */
  function showTaskQuran(info, resubmit) {
    app.renderQuranParts($('#tf-quran'), info, { lang: $('#tf-lang').value, onUseMushaf: (mushaf) => useTaskMushaf(mushaf, resubmit, info) });
    setTaskMeaningOff(!!(info && info.parts && info.parts.length));
  }

  function setTaskMeaningOff(off) {
    const meaning = $('input[name="tf-mode"][value="contextual"]');
    if (off && meaning.checked) setRadio('tf-mode', 'strict');
    meaning.disabled = off;
    const why = $('#tf-mode-why');
    if (off) app.setT(why, 'mode_meaning_off');
    else app.setT(why, null);
    why.hidden = !off;
    updateFormKind();
  }

  /**
   * "Use the mushaf text" in the task form: the mushaf words go into the text. The parts
   * stay listed (without differences) until the server checks the new text; after
   * "Save" the check runs again at once.
   */
  function useTaskMushaf(mushaf, resubmit, info) {
    if (typeof mushaf !== 'string' || !mushaf.trim()) return;
    $('#tf-text').value = mushaf;
    const parts = info && info.parts ? info.parts.map((p) => Object.assign({}, p, { differences: [] })) : [];
    showTaskQuran(parts.length ? { parts, mushafText: mushaf, text: mushaf, mushafUsed: true } : null, resubmit);
    app.clearStatus($('#tf-status'));
    if (resubmit) submitTaskForm();
    else $('#tf-text').focus();
  }

  /** The text (or its language) was changed: what the server said about it is out of date. */
  function taskTextChanged() {
    if (!$('#tf-quran').hidden || $('#tf-mode-why').dataset.i18n) showTaskQuran(null);
    $('#tf-to-quran').hidden = true;
  }

  /**
   * A text that is Quran: "Create a Quran task with these ayat" turns the form (a new
   * task) into a Quran task on `range` ({surah, from, to}); placed after `after`.
   */
  function offerQuranTask(range, after) {
    const btn = $('#tf-to-quran');
    const f = session.taskForm;
    const can = !!(range && f && !f.id);
    btn.hidden = !can;
    if (!can) return;
    after.after(btn);
    btn.onclick = () => {
      btn.hidden = true;
      setRadio('tf-kind', 'quran');
      $('#tf-surah').dataset.want = String(range.surah);
      $('#tf-from').value = app.fmtNum(range.from);
      $('#tf-to').value = app.fmtNum(range.to);
      for (const id of ['#tf-status', '#tf-quran-note']) app.clearStatus($(id));
      showTaskQuran(null);
      updateFormKind();
      $('#tf-surah').focus();
    };
  }

  /** Show the fields of the chosen kind (and mode). */
  function updateFormKind() {
    const kind = formKind();
    const contextual = kind === 'recite' && formMode() === 'contextual';
    $('#tf-text-group').hidden = kind === 'quran';
    $('#tf-mode').hidden = kind !== 'recite';
    $('#tf-quran-group').hidden = kind !== 'quran';
    $('#tf-pass').hidden = contextual;
    $('#tf-pass-meaning').hidden = !contextual;
    updateTaskOfflineNote();
    app.setTextLang($('#tf-text'), $('#tf-lang').value);
    if (kind === 'quran') fillSurahSelect();
  }

  /**
   * Without the online AI, a recite task by meaning is checked only approximately: said
   * under the mode choice as on Prepare, while "The meaning" can be chosen. That is so
   * without Claude on the server, and also with Claude set up while the AI consent does
   * not count: the check is then sent without ai_consent=1 and the server judges the
   * meaning with its offline heuristic (app.aiConsentNow, the test of every request).
   * Called again when the health arrives after the form opened (onHealth) and after
   * every change of the consent (syncApp).
   */
  function updateTaskOfflineNote() {
    const note = $('#tf-mode-offline-note');
    if (!note) return;
    const h = app.health();
    const meaning = $('input[name="tf-mode"][value="contextual"]');
    note.hidden = !(h && !app.aiConsentNow() && formKind() === 'recite' && !meaning.disabled);
  }

  /**
   * /api/health answered (at the start, again before a photo is sent, or after a request
   * sent with the AI consent was answered by the offline brain): the task form's note, and
   * the AI consent prompt and box of the parent area (Claude may have been set up, or
   * turned off, since the page loaded).
   */
  function onHealth() {
    updateTaskOfflineNote();
    if (store.doc && app.screen() === 'parent' && session.section === 'settings') renderSettings();
  }

  function setRadio(name, value) {
    for (const r of $$('input[name="' + name + '"]')) r.checked = r.value === String(value);
  }

  function fillStarsSelect(value) {
    const s = $('#tf-stars');
    s.textContent = '';
    for (let n = R.LIMITS.starsMin; n <= R.LIMITS.starsMax; n++) s.append(el('option', { value: n }, app.fmtNum(n) + ' ' + starsText(n)));
    s.value = String(value);
  }

  let surahsCache = null;

  /** The surah select of the task form (all 114 surahs), in the parent's language. */
  async function fillSurahSelect() {
    const select = $('#tf-surah');
    const status = $('#tf-surah-status');
    const want = select.dataset.want || select.value;
    if (!surahsCache) {
      try {
        surahsCache = await app.loadSurahs();
        app.clearStatus(status);
      } catch (err) {
        app.showError(status, err);
        return;
      }
    }
    select.textContent = '';
    for (const s of surahsCache) {
      const num = app.fmtNum(s.number);
      select.append(el('option', { value: s.number }, app.uiLang() !== 'ar' && s.name_translit ? num + '. ' + s.name_translit + ' — ' + s.name_ar : num + '. ' + s.name_ar));
    }
    if (want) select.value = String(want);
    delete select.dataset.want;
  }

  function surahInfo(n) {
    return surahsCache ? surahsCache.find((s) => s.number === n) || null : null;
  }

  function rangeValue(sel) {
    const s = app.asciiDigits($(sel).value).replace(/[^0-9]/g, '');
    return s ? Number(s) : NaN;
  }

  function openTaskForm(taskId) {
    const doc = store.doc;
    const childId = session.ptChildId;
    const child = doc.children.find((c) => c.id === childId);
    if (!child) return;
    const task = taskId ? doc.tasks.find((x) => x.id === taskId) : null;
    session.taskForm = { id: task ? task.id : null, childId, token: (session.taskForm ? session.taskForm.token : 0) + 1 };
    app.setT($('#tf-h'), task ? 'fam_task_edit_title' : 'fam_task_new');
    const kind = task ? task.kind : 'recite';
    setRadio('tf-kind', kind);
    for (const r of $$('input[name="tf-kind"]')) r.disabled = !!task; // the kind of a task never changes
    $('#tf-title').value = task ? task.title : '';
    $('#tf-text').value = task && task.text ? task.text : '';
    $('#tf-lang').value = task && task.lang ? task.lang : child.lang;
    setRadio('tf-mode', task && task.mode ? task.mode : 'strict');
    const q = task && task.quran ? task.quran : { surah: child.quran.surah, from: child.quran.from, to: child.quran.to, memory: false };
    $('#tf-surah').dataset.want = String(q.surah);
    $('#tf-from').value = app.fmtNum(q.from);
    $('#tf-to').value = app.fmtNum(q.to);
    setRadio('tf-qmode', q.memory ? 'memory' : 'looking');
    setRadio('tf-pass', task ? task.pass.minAccuracy : 1);
    fillStarsSelect(task ? task.stars : R.LIMITS.starsDefault);
    $('#tf-reward-text').value = task && task.reward ? task.reward.text : '';
    renderEmojiPick($('#tf-emojis'), R.REWARD_EMOJIS, task && task.reward ? task.reward.emoji : R.REWARD_EMOJIS[0]);
    $('#tf-due').value = task && task.due ? task.due : '';
    // "More options" is open when the task uses one of them.
    $('#tf-more').open = !!task && (!!task.reward || !!task.due || task.pass.minAccuracy !== 1 || task.title !== R.defaultTitle(task.kind, task));
    for (const id of ['#tf-status', '#tf-photo-status', '#tf-quran-note', '#tf-surah-status']) app.clearStatus($(id));
    showTaskQuran(null);
    $('#tf-to-quran').hidden = true;
    if (task && task.kind !== 'quran') {
      // The Quran parts of the saved text, so that "The meaning" is off from the start
      // (a task by meaning with Quran words gets "Word by word": saving it fixes it).
      const token = session.taskForm.token;
      const apply = () => {
        const info = textInfoFor(task);
        if (!info || !session.taskForm || session.taskForm.token !== token) return;
        if ($('#tf-text').value.trim() !== task.text || $('#tf-lang').value !== task.lang) return;
        if (info.parts.length) showTaskQuran(info, true);
        else if (!info.contextual) setTaskMeaningOff(true);
      };
      if (textInfoFor(task, apply)) apply();
    }
    $('#tf').hidden = false;
    $('#pt-new').hidden = true;
    updateFormKind();
    app.refreshGates();
    $('#tf-h').focus();
  }

  function closeTaskForm() {
    if (session.taskForm) session.taskForm.token++;
    session.taskForm = null;
    $('#tf').hidden = true;
    for (const b of [$('#tf-save'), $('#tf-cancel')]) b.disabled = false;
    if ($('#pt-new')) $('#pt-new').hidden = !session.ptChildId;
  }

  /**
   * The text of the task checked by the server in the mode of the task: {key} for an
   * error (with `range` for a text that is Quran, `res` when a check in mode strict
   * answered), or {res} (app.checkText's answer, with the Quran parts). A school text
   * that includes Quran is accepted (word by word; a grown-up reads its Quran parts in a
   * dictation). When mode contextual or dictation refuses it with quran_text, one more
   * check in mode strict tells a text that is Quran from a school text with Quran parts
   * (refused by meaning) or from the safety net of the dictation.
   */
  async function checkTaskText(text, lang, kind, mode) {
    const checkMode = kind === 'dictation' ? 'dictation' : mode;
    try {
      const res = await app.checkText(text, lang, checkMode);
      if (res.words === 0) return { key: 'error_no_words' };
      if (kind === 'dictation' && !res.dictation) return { key: 'fam_err_quran_unmarked_task', res };
      return { res };
    } catch (err) {
      if (!err || err.name !== 'ApiError') return { key: 'error_generic' };
      if (err.status === 0) return { key: 'fam_err_offline' };
      if (err.code === 'quran_text') {
        if (checkMode === 'strict' || err.quranRange) return { key: 'fam_err_quran_task', range: err.quranRange };
        try {
          const res = await app.checkText(text, lang, 'strict');
          return { key: checkMode === 'contextual' ? 'fam_err_quran_meaning_task' : 'fam_err_quran_unmarked_task', res };
        } catch (e2) {
          if (e2 && e2.name === 'ApiError' && e2.status === 0) return { key: 'fam_err_offline' };
          return { key: 'fam_err_quran_task', range: e2 && e2.quranRange };
        }
      }
      return { key: app.errorInfo(err).key };
    }
  }

  async function submitTaskForm() {
    const f = session.taskForm;
    if (!f) return;
    const token = f.token;
    const status = $('#tf-status');
    const doc = store.doc;
    const task = f.id ? doc.tasks.find((x) => x.id === f.id) : null;
    const kind = task ? task.kind : formKind();
    const fail = (key, focus) => {
      app.setStatus(status, key, null, { error: true });
      if (focus) {
        const more = focus.closest('details');
        if (more) more.open = true;
        focus.focus();
      }
    };
    let withQuran = false;
    const common = {};
    const title = $('#tf-title').value.trim();
    common.title = title ? title : task ? null : undefined;
    common.stars = Number($('#tf-stars').value);
    const rewardText = $('#tf-reward-text').value.trim();
    common.reward = rewardText ? { text: rewardText, emoji: pickedEmoji($('#tf-emojis')) || R.REWARD_EMOJIS[0] } : null;
    const due = $('#tf-due').value;
    if (due && !/^\d{4}-\d{2}-\d{2}$/.test(due)) return fail('fam_err_due', $('#tf-due'));
    common.due = due || null;
    const passValue = Number(($('input[name="tf-pass"]:checked') || { value: '1' }).value);
    common.pass = { minAccuracy: R.MIN_ACCURACIES.includes(passValue) ? passValue : 1 };
    const opts = {};
    const content = {};
    if (kind === 'quran') {
      const surah = Number($('#tf-surah').value);
      const info = surahInfo(surah);
      const from = rangeValue('#tf-from');
      const to = rangeValue('#tf-to');
      if (!info || !Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to < from || to > info.ayah_count || to - from + 1 > MAX_AYAT) {
        return fail('fam_err_quran_range', $('#tf-from'));
      }
      content.quran = { surah, from, to, memory: ($('input[name="tf-qmode"]:checked') || {}).value === 'memory' };
      opts.ayahCount = info.ayah_count;
      // The default title is read by the child: in the child's language.
      const owner = doc.children.find((c) => c.id === f.childId);
      const lang = owner ? owner.lang : parentLang();
      opts.surahName = app.tIn(lang, 'fam_quran_title', { name: lang !== 'ar' && info.name_translit ? info.name_translit : info.name_ar, from, to });
    } else {
      const text = $('#tf-text').value.trim();
      const lang = $('#tf-lang').value;
      if (!text) return fail('fam_tf_text_empty', $('#tf-text'));
      content.text = text;
      content.lang = lang;
      if (kind === 'recite') content.mode = formMode();
      const unchanged = task && task.text === text && task.lang === lang && (kind !== 'recite' || task.mode === content.mode);
      if (!unchanged) {
        // Saving needs a successful check of the text, in the mode of the task.
        app.setStatus(status, 'checking_text');
        $('#tf-save').disabled = true;
        const out = await checkTaskText(text, lang, kind, content.mode);
        if (!session.taskForm || session.taskForm.token !== token) return; // closed meanwhile
        $('#tf-save').disabled = false;
        // The Quran parts of the text, with their differences from the mushaf.
        const parts = out.res ? out.res.quranParts : [];
        showTaskQuran(parts.length ? { parts, mushafText: out.res.mushafText, text } : null, true);
        offerQuranTask(out.range || null, status);
        const diffs = parts.some((p) => p.differences.length);
        const focusParts = () => ($('#tf-quran').hidden ? $('#tf-mode') : $('#tf-quran'));
        // A recite task with words that differ from the mushaf: the child would read the
        // misquote, so the mushaf text is needed before saving (UX-03); with "The meaning"
        // refused as well, one message says both (UX-06).
        if (kind === 'recite' && diffs) {
          fail(out.key === 'fam_err_quran_meaning_task' ? 'fam_err_quran_meaning_diff' : 'fam_err_quran_diff_recite');
          focusParts().focus();
          return;
        }
        if (out.key === 'fam_err_quran_meaning_task') {
          fail(out.key);
          focusParts().focus();
          return;
        }
        if (out.key) return fail(out.key, out.key === 'fam_err_offline' ? null : $('#tf-text'));
        if (out.res) rememberTextInfo(text, lang, out.res, kind === 'recite' && content.mode === 'contextual' ? true : out.res.contextual);
        // A dictation with differences: shown once before saving ("Use the mushaf text",
        // or "Save" again to keep the text as typed: the child never sees the typed Quran
        // words, a grown-up reads the mushaf text, and the checks use the mushaf words).
        if (diffs && f.diffSeen !== text) {
          f.diffSeen = text;
          app.setStatus(status, 'fam_err_quran_diff_task', null, { error: true });
          $('#tf-quran').focus();
          return;
        }
        // The default title is read by the child: from the mushaf words, never a misquote.
        if (diffs && !title && !task && out.res.mushafText.trim()) common.title = R.defaultTitle(kind, { text: out.res.mushafText.trim() });
        withQuran = parts.length > 0;
      }
    }
    try {
      if (task) {
        const patch = Object.assign({}, common, content);
        if (patch.title === undefined) delete patch.title;
        update((d, now) => R.updateTask(d, task.id, patch, now, opts));
      } else {
        const input = Object.assign({ childId: f.childId, kind }, common, content);
        if (input.title === undefined) delete input.title;
        update((d, now) => R.createTask(d, input, now, opts).doc);
      }
    } catch (err) {
      if (isRewardsError(err, 'bad_input')) {
        const field = String(err.field || '');
        if (field.startsWith('quran')) return fail('fam_err_quran_range', $('#tf-from'));
        if (field === 'due') return fail('fam_err_due', $('#tf-due'));
        if (field === 'text') return fail('error_text_too_long', $('#tf-text'));
      }
      return fail('error_generic');
    }
    closeTaskForm();
    renderParent(); // an edit of a waiting task can send it back to "To do": the counts change too
    app.setStatus($('#pt-status'), withQuran ? 'fam_task_saved_quran' : 'fam_task_saved');
    $('#pt-new').focus();
  }

  /** A photo of the page read into the task text, with the review of Prepare. */
  async function readTaskPhoto(input) {
    const file = app.takeFile(input);
    if (!file || !app.isOpen('prep-photo')) return;
    const status = $('#tf-photo-status');
    const note = $('#tf-quran-note');
    app.clearStatus(note);
    taskTextChanged();
    app.setStatus(status, 'reading_page');
    const inputs = [$('#tf-take'), $('#tf-choose')];
    for (const n of inputs) n.dataset.busy = '1';
    app.refreshGates();
    try {
      const res = await app.readPage(file, $('#tf-lang').value);
      const text = typeof res.text === 'string' ? res.text : '';
      if (R.LANGS.includes(res.lang)) $('#tf-lang').value = res.lang;
      $('#tf-text').value = text;
      app.setTextLang($('#tf-text'), $('#tf-lang').value);
      app.setPageReadStatus(status, res, text);
      // A page that is Quran (the server decides): a Quran task, on its ayat when they are
      // one range. A school page that includes Quran: its Quran parts, as on Prepare.
      if (res.contains_quran === true) {
        app.setStatus(note, 'fam_page_has_quran');
        offerQuranTask(app.quranRangeOf(res.quran_range), note);
      } else {
        const parts = app.quranPartsOf(res.quran_parts);
        if (parts.length) showTaskQuran({ parts, mushafText: typeof res.mushaf_text === 'string' ? res.mushaf_text : text, text }, false);
      }
      $('#tf-text').focus();
    } catch (err) {
      if (err && err.code === 'needs_manual') app.setStatus(status, 'page_needs_manual');
      else if (err && err.name === 'ApiError') app.showError(status, err);
      else app.setStatus(status, 'photo_bad', null, { error: true });
    } finally {
      for (const n of inputs) delete n.dataset.busy;
      app.refreshGates();
    }
  }

  function initParent() {
    for (const tab of $$('#psec-nav .psec-tab')) tab.addEventListener('click', () => showSection(tab.dataset.psec));
    $('#btn-parent-close').addEventListener('click', closeParent);
    $('#parent-reset-ok').addEventListener('click', () => {
      try {
        update((d, now) => R.dismissPinReset(d, now));
      } catch (err) {
        /* storage notices are shown by commit */
      }
      renderPinResetNotice();
    });
    $('#settings-consent').addEventListener('change', onSettingsConsent);
    $('#settings-ai-consent').addEventListener('change', onSettingsAiConsent);
    // Children
    $('#pc-add').addEventListener('click', () => openChildForm(null));
    $('#cf').addEventListener('submit', (e) => {
      e.preventDefault();
      submitChildForm();
    });
    $('#cf-cancel').addEventListener('click', () => {
      closeChildForm();
      $('#pc-add').focus();
    });
    $('#pc-remove-yes').addEventListener('click', confirmRemove);
    $('#pc-remove-no').addEventListener('click', () => {
      hideRemoveConfirm();
      $('#pc-add').focus();
    });
    // Tasks
    $('#pt-child').addEventListener('change', (e) => {
      session.ptChildId = e.target.value;
      closeTaskForm();
      session.detailTaskId = null;
      session.undoing = null;
      app.clearStatus($('#pt-status'));
      renderTasks();
    });
    // Rewards (the same choice of child as Tasks)
    $('#prw-child').addEventListener('change', (e) => {
      session.ptChildId = e.target.value;
      closeRewardForm();
      session.ledgerAll = false;
      app.clearStatus($('#prw-status'));
      renderRewards();
    });
    $('#prw-goal-add').addEventListener('click', () => openRewardForm('goal'));
    $('#prw-surprise-open').addEventListener('click', () => openRewardForm('surprise'));
    $('#prw-adjust-open').addEventListener('click', () => openRewardForm('adjust'));
    for (const [form, submit] of [['#gf', submitGoal], ['#sf', submitSurprise], ['#af', submitAdjust]]) {
      $(form).addEventListener('submit', (e) => {
        e.preventDefault();
        submit();
      });
    }
    for (const id of ['#gf-cancel', '#sf-cancel', '#af-cancel']) $(id).addEventListener('click', cancelRewardForm);
    $('#prw-ledger-more').addEventListener('click', () => {
      session.ledgerAll = !session.ledgerAll;
      renderRewards();
      $('#prw-ledger-more').focus();
    });
    // Settings
    $('#ps-pin-change').addEventListener('click', changePin);
    $('#ps-lang').addEventListener('change', onParentLang);
    $('#ps-delete').addEventListener('click', () => askDelete(1));
    $('#ps-delete-next').addEventListener('click', () => askDelete(2));
    for (const id of ['#ps-delete-no1', '#ps-delete-no2']) $(id).addEventListener('click', () => askDelete(0));
    $('#ps-delete-yes').addEventListener('click', deleteAllData);
    $('#ps-copy-save').addEventListener('click', saveCopy);
    $('#ps-copy-file').addEventListener('change', onSettingsCopyFile);
    $('#ps-copy-yes').addEventListener('click', replaceWithCopy);
    $('#ps-copy-no').addEventListener('click', cancelCopy);
    $('#pt-new').addEventListener('click', () => {
      app.clearStatus($('#pt-status'));
      openTaskForm(null);
    });
    $('#tf').addEventListener('submit', (e) => {
      e.preventDefault();
      submitTaskForm();
    });
    $('#tf-cancel').addEventListener('click', () => {
      closeTaskForm();
      renderTasks();
      $('#pt-new').focus();
    });
    for (const r of $$('input[name="tf-kind"], input[name="tf-mode"]')) r.addEventListener('change', updateFormKind);
    $('#tf-lang').addEventListener('change', () => {
      app.setTextLang($('#tf-text'), $('#tf-lang').value);
      taskTextChanged();
    });
    $('#tf-text').addEventListener('input', taskTextChanged);
    $('#tf-surah').addEventListener('change', () => {
      const info = surahInfo(Number($('#tf-surah').value));
      if (!info) return;
      $('#tf-from').value = app.fmtNum(1);
      $('#tf-to').value = app.fmtNum(Math.min(info.ayah_count, 10));
    });
    for (const id of ['#tf-take', '#tf-choose']) $(id).addEventListener('change', (e) => readTaskPhoto(e.target));
  }

  // ===========================================================================
  // Attach to app.js
  // ===========================================================================

  let attached = false;

  function attach(appApi) {
    if (attached || !appApi || !R) return;
    attached = true;
    app = appApi;
    app.addStrings(STRINGS);
    // Every session starts on the setup (first run) or on "Who is learning?" (with the
    // AI disclosure), never straight on a child's screen.
    store.doc = loadDoc();
    initSetup();
    initPinDialog();
    initAutoLock();
    initParent();
    $('#data-notice-close').addEventListener('click', () => {
      $('#data-notice').hidden = true;
    });
    for (const id of ['#btn-who-parents', '#btn-home-parents']) $(id).addEventListener('click', openParent);
    // (Redesign) A child adds their own profile; My texts.
    $('#who-add-open').addEventListener('click', openWhoAdd);
    $('#who-add').addEventListener('submit', (e) => {
      e.preventDefault();
      submitWhoAdd();
    });
    $('#wa-cancel').addEventListener('click', () => {
      closeWhoAdd();
      renderWho();
      $('#who-add-open').focus();
    });
    $('#texts-new').addEventListener('click', newText);
    $('#btn-switch-child').addEventListener('click', () => {
      session.childId = null;
      syncApp();
      app.go('who');
    });
    window.addEventListener('storage', onStorage);
    syncApp();
    app.setHooks({ route, langFor, enter, leave, onQuranPrefs, onLanguage: redraw, onHealth, onTextSaved, onPractice });
  }

  window.MommyFamily = Object.freeze({ attach });
  if (window.MommyApp) attach(window.MommyApp);
})();
