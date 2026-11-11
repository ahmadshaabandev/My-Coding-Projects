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
      fam_setup_lead: 'A grown-up sets up the app once, for the whole family.',
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
      fam_who_empty: 'No child yet. A grown-up can add one in the parent area.',
      fam_for_parents: 'For parents',
      fam_jar: 'Stars in the jar: {n}',
      fam_goal_missing: '{n} more stars to: {reward}',
      fam_goal_missing_one: '{n} more star to: {reward}',
      fam_goal_reached: 'Enough stars for: {reward}! Tell your parent.',
      fam_todo: 'To do',
      fam_waiting: 'Waiting for your parent',
      fam_done: 'Done',
      fam_todo_empty: 'Nothing to do right now.',
      fam_waiting_empty: 'Nothing is waiting.',
      fam_done_empty: 'Finished tasks will be shown here.',
      fam_free: 'Free practice',
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
      fam_reward_unlocked: 'Unlocked: ask your parent',
      fam_reward_given: 'Received',
      fam_surprise_title: 'A surprise for you!',
      fam_surprise_ok: 'Thank you!',
      fam_task_banner_label: 'Task',
      fam_task_leave: 'Back to my tasks',
      fam_celebrate: 'Well done! Your parent will check it, then you get your stars {stars}.',
      fam_celebrate_reward: 'Well done! Your parent will check it, then you get your stars {stars} and {reward}.',
      fam_improve: '{n} more words right than last time!',
      fam_improve_one: '{n} more word right than last time!',
      fam_try_again: 'Try again whenever you are ready.',
      fam_dict_shortcut: 'This dictation reaches the pass level of the task.',
      fam_confirm_task_now: 'Confirm the task now',
      fam_task_confirmed: 'Task confirmed: the stars {stars} are in the jar.',
      fam_reward_unlocked_now: 'Reward unlocked: {reward}',
      fam_pin_enter_title: 'Parent area',
      fam_pin_enter_intro: 'Please type the parent PIN. It is a child lock: it keeps this area for the grown-ups.',
      fam_pin_confirm_title: 'Confirm the task',
      fam_pin_confirm_intro: 'Please type the parent PIN to confirm the task.',
      fam_pin_label: 'PIN',
      fam_pin_create_title: 'Create the parent PIN',
      fam_pin_create_intro: 'Please choose a PIN of 4 to 6 digits and type it twice. It is a child lock: it keeps the parent area for the grown-ups.',
      fam_pin_reset_intro: 'The PIN was removed and all the data is kept. Please choose a new PIN and type it twice.',
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
      fam_parent_title: 'Parent area',
      fam_parent_help: 'Praise and surprises keep children wanting to learn; rewards work best for effort the child can see.',
      fam_parent_sections: 'Sections of the parent area',
      fam_sec_review: 'To review',
      fam_sec_tasks: 'Tasks',
      fam_sec_rewards: 'Rewards',
      fam_sec_children: 'Children',
      fam_sec_settings: 'Settings',
      fam_placeholder: 'This section is being built.',
      fam_parent_close: 'Close the parent area',
      fam_privacy_line: 'Everything here stays on this device.',
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
      fam_status_assigned: 'To do',
      fam_status_ready: 'Waiting for review',
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
      fam_err_quran_phrase_task: 'Part of this text is an ayah of the Quran (for example the basmala), and the app never reads the Quran aloud, so this text cannot be a dictation task. It can be a recite task, word by word.',
      fam_err_quran_meaning_task: 'This text has words of the Quran (for example the basmala), so it is recited word by word only. Please choose “Word by word”.',
      fam_err_offline: 'The text could not be checked: the server cannot be reached. The form is kept; please try again when the server is back.',
      fam_err_quran_range: 'Please choose valid ayat: at most 50, inside the surah.',
      fam_err_due: 'Please choose a valid date.',
      fam_page_has_quran: 'This page seems to contain Quran text. For the Quran, please create a task of the kind “Quran”.',
      fam_child_add: 'Add a child',
      fam_child_new_title: 'New child',
      fam_child_edit_title: 'Edit the profile',
      fam_remove: 'Remove',
      fam_child_remove_q: 'Remove the profile of {name}? All the tasks, stars and rewards of this profile on this device are deleted too. This cannot be undone.',
      fam_child_removed: 'The profile was removed, with all its data.',
      fam_child_saved: 'Saved.',
      fam_quran_title: '{name} {from}–{to}',
    },

    fr: {
      fam_setup_lead: 'Un adulte prépare l’application une seule fois, pour toute la famille.',
      fam_setup_title: 'Préparer la famille',
      fam_parent_lang: 'Langue pour les adultes',
      fam_pin_legend: 'Code parent',
      fam_pin_about: 'Le code est un verrou contre les enfants : il garde l’espace parents pour les adultes. Il a de 4 à 6 chiffres.',
      fam_pin_new: 'Nouveau code',
      fam_pin_again: 'Le même code une deuxième fois',
      fam_first_child: 'Le premier enfant',
      fam_child_lang: 'Langue de l’enfant',
      fam_avatar: 'Image',
      fam_err_nickname: 'Tapez un surnom.',
      fam_err_pin_format: 'Un code a de 4 à 6 chiffres.',
      fam_err_pin_same: 'Les deux codes ne sont pas pareils. Tapez-les de nouveau.',
      fam_err_crypto: 'Le code ne peut pas être utilisé sur cette page : il faut https ou localhost.',
      fam_saving: 'Enregistrement…',
      fam_ok: 'OK',
      fam_notice_corrupt: 'Les données de la famille enregistrées sur cet appareil n’ont pas pu être lues. Elles ont été mises de côté sur cet appareil, et tout recommence.',
      fam_notice_repaired: 'Une partie des données de la famille sur cet appareil était abîmée et a été réparée. Une copie des anciennes données a été gardée sur cet appareil.',
      fam_notice_quota: 'Le stockage de ce navigateur est plein : la dernière modification n’a pas pu être enregistrée. Libérez de la place (par exemple d’anciennes données de sites), puis réessayez.',
      fam_notice_memory: 'Ce navigateur ne permet pas d’enregistrer ici (navigation privée ?). Tout fonctionne jusqu’à la fermeture de la page, puis les données sont perdues.',
      fam_who_title: 'Qui apprend aujourd’hui ?',
      fam_who_empty: 'Pas encore d’enfant. Un adulte peut en ajouter un dans l’espace parents.',
      fam_for_parents: 'Pour les parents',
      fam_jar: 'Étoiles dans le bocal : {n}',
      fam_goal_missing: 'Encore {n} étoiles pour : {reward}',
      fam_goal_missing_one: 'Encore {n} étoile pour : {reward}',
      fam_goal_reached: 'Assez d’étoiles pour : {reward} ! Parles-en à ton parent.',
      fam_todo: 'À faire',
      fam_waiting: 'Un parent va vérifier',
      fam_done: 'Terminé',
      fam_todo_empty: 'Rien à faire pour l’instant.',
      fam_waiting_empty: 'Rien n’attend.',
      fam_done_empty: 'Les tâches terminées seront ici.',
      fam_free: 'Entraînement libre',
      fam_switch_child: 'Changer d’enfant',
      fam_kind_recite: 'Réciter',
      fam_kind_dictation: 'Dictée',
      fam_kind_quran: 'Coran',
      fam_stars_n: 'Étoiles : {n}',
      fam_due: 'Pour le {date}',
      fam_reward_label: 'Récompense :',
      fam_note_label: 'Note :',
      fam_start: 'Commencer',
      fam_pass_all_words: 'Tous les mots justes',
      fam_pass_nine_in_ten: '9 mots sur 10',
      fam_pass_eight_in_ten: '8 mots sur 10',
      fam_pass_same_meaning: 'Même sens',
      fam_pass_line: 'Pour réussir : {rule}',
      fam_reward_unlocked: 'Débloquée : demande-la à ton parent',
      fam_reward_given: 'Reçue',
      fam_surprise_title: 'Une surprise pour toi !',
      fam_surprise_ok: 'Merci !',
      fam_task_banner_label: 'Tâche',
      fam_task_leave: 'Retour à mes tâches',
      fam_celebrate: 'Bravo ! Ton parent va vérifier, puis tu auras tes étoiles {stars}.',
      fam_celebrate_reward: 'Bravo ! Ton parent va vérifier, puis tu auras tes étoiles {stars} et {reward}.',
      fam_improve: '{n} mots justes de plus que la dernière fois !',
      fam_improve_one: '{n} mot juste de plus que la dernière fois !',
      fam_try_again: 'Tu peux réessayer quand tu veux.',
      fam_dict_shortcut: 'Cette dictée atteint le niveau de réussite de la tâche.',
      fam_confirm_task_now: 'Valider la tâche maintenant',
      fam_task_confirmed: 'Tâche validée : les étoiles {stars} sont dans le bocal.',
      fam_reward_unlocked_now: 'Récompense débloquée : {reward}',
      fam_pin_enter_title: 'Espace parents',
      fam_pin_enter_intro: 'Tapez le code parent. C’est un verrou contre les enfants : il garde cet espace pour les adultes.',
      fam_pin_confirm_title: 'Valider la tâche',
      fam_pin_confirm_intro: 'Tapez le code parent pour valider la tâche.',
      fam_pin_label: 'Code',
      fam_pin_create_title: 'Créer le code parent',
      fam_pin_create_intro: 'Choisissez un code de 4 à 6 chiffres et tapez-le deux fois. C’est un verrou contre les enfants : il garde l’espace parents pour les adultes.',
      fam_pin_reset_intro: 'Le code a été effacé et toutes les données sont gardées. Choisissez un nouveau code et tapez-le deux fois.',
      fam_unlock: 'Ouvrir',
      fam_confirm: 'Valider',
      fam_create: 'Créer',
      fam_cancel: 'Annuler',
      fam_forgot: 'Code oublié ?',
      fam_pin_wrong: 'Code faux. Essais restants avant une pause : {n}.',
      fam_pin_wrong_last: 'Code faux.',
      fam_pin_locked: 'Trop d’essais. Attendez {time} avant de réessayer.',
      fam_pin_checking: 'Vérification…',
      fam_gate_title: 'Code oublié',
      fam_gate_intro: 'Pour créer un nouveau code, répondez à cette question pour les adultes. Toutes les données sont gardées.',
      fam_gate_q: 'Combien font {a} fois {b} ? Tapez la réponse en chiffres.',
      fam_gate_wrong: 'Ce n’est pas la bonne réponse. Voici une autre question.',
      fam_gate_check: 'Vérifier',
      fam_n3: 'trois',
      fam_n4: 'quatre',
      fam_n5: 'cinq',
      fam_n6: 'six',
      fam_n7: 'sept',
      fam_n8: 'huit',
      fam_n9: 'neuf',
      fam_parent_title: 'Espace parents',
      fam_parent_help: 'Les compliments et les surprises donnent envie d’apprendre ; les récompenses marchent le mieux pour un effort que l’enfant peut voir.',
      fam_parent_sections: 'Rubriques de l’espace parents',
      fam_sec_review: 'À vérifier',
      fam_sec_tasks: 'Tâches',
      fam_sec_rewards: 'Récompenses',
      fam_sec_children: 'Enfants',
      fam_sec_settings: 'Réglages',
      fam_placeholder: 'Cette rubrique est en préparation.',
      fam_parent_close: 'Fermer l’espace parents',
      fam_privacy_line: 'Tout ce qui est ici reste sur cet appareil.',
      fam_tasks_of: 'Enfant',
      fam_tasks_nochild: 'Ajoutez d’abord un enfant, dans la rubrique « Enfants ».',
      fam_tasks_empty: 'Pas encore de tâche.',
      fam_tasks_archived: 'Tâches archivées : {n}',
      fam_task_new: 'Nouvelle tâche',
      fam_task_edit_title: 'Modifier la tâche',
      fam_edit: 'Modifier',
      fam_archive: 'Archiver',
      fam_task_archived: 'La tâche a été archivée.',
      fam_task_saved: 'La tâche a été enregistrée.',
      fam_status_assigned: 'À faire',
      fam_status_ready: 'À vérifier',
      fam_status_done: 'Terminée',
      fam_tf_kind: 'Type de tâche',
      fam_tf_title: 'Titre (facultatif)',
      fam_tf_title_ph: 'Les premiers mots du texte',
      fam_tf_text: 'Texte',
      fam_tf_qmode: 'Comment l’enfant récite',
      fam_tf_quran_note: 'Une tâche de Coran est toujours vérifiée mot à mot, avec le texte exact de Tanzil.',
      fam_tf_pass: 'Niveau de réussite',
      fam_tf_pass_meaning: 'Avec « Le sens », la tâche est réussie quand le sens est le même, sans idée oubliée.',
      fam_tf_stars: 'Étoiles',
      fam_tf_due: 'Pour le (facultatif)',
      fam_tf_reward: 'Récompense (facultative)',
      fam_tf_reward_text: 'La récompense',
      fam_tf_reward_ph: 'ex. une glace',
      fam_tf_reward_emoji: 'Image de la récompense',
      fam_save: 'Enregistrer',
      fam_err_quran_task: 'Ce texte vient du Coran. Créez plutôt une tâche de type « Coran ».',
      fam_err_quran_phrase_task: 'Une partie de ce texte est un verset du Coran (par exemple la basmala), et l’application ne lit jamais le Coran à voix haute : ce texte ne peut donc pas servir à une tâche de dictée. Il peut servir à une tâche de récitation mot à mot.',
      fam_err_quran_meaning_task: 'Ce texte contient des mots du Coran (par exemple la basmala) : il se récite seulement mot à mot. Choisissez « Mot à mot ».',
      fam_err_offline: 'Le texte n’a pas pu être vérifié : le serveur ne répond pas. Le formulaire est gardé ; réessayez quand le serveur sera revenu.',
      fam_err_quran_range: 'Choisissez des âyât valables : 50 au maximum, dans la sourate.',
      fam_err_due: 'Choisissez une date valable.',
      fam_page_has_quran: 'Cette page semble contenir un texte du Coran. Pour le Coran, créez une tâche de type « Coran ».',
      fam_child_add: 'Ajouter un enfant',
      fam_child_new_title: 'Nouvel enfant',
      fam_child_edit_title: 'Modifier le profil',
      fam_remove: 'Supprimer',
      fam_child_remove_q: 'Supprimer le profil de {name} ? Toutes les tâches, étoiles et récompenses de ce profil sur cet appareil sont aussi effacées. C’est définitif.',
      fam_child_removed: 'Le profil a été supprimé, avec toutes ses données.',
      fam_child_saved: 'C’est enregistré.',
      fam_quran_title: '{name} {from}–{to}',
    },

    ar: {
      fam_setup_lead: 'يُعِدّ أحد الكبار التطبيق مرة واحدة للعائلة كلها.',
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
      fam_who_empty: 'لا يوجد أطفال بعد. يمكن لأحد الكبار إضافة طفل في قسم الكبار.',
      fam_for_parents: 'للكبار',
      fam_jar: 'النجوم في الجرّة: {n}',
      fam_goal_missing: 'النجوم الباقية حتى {reward}: {n}',
      fam_goal_missing_one: 'النجوم الباقية حتى {reward}: {n}',
      fam_goal_reached: 'النجوم تكفي الآن لـ {reward}! هيا نخبر أحد الوالدين.',
      fam_todo: 'المهام المطلوبة',
      fam_waiting: 'بانتظار أحد الوالدين',
      fam_done: 'المهام المنجزة',
      fam_todo_empty: 'لا توجد مهام الآن.',
      fam_waiting_empty: 'لا شيء بالانتظار.',
      fam_done_empty: 'ستظهر هنا المهام المنجزة.',
      fam_free: 'التدرّب الحرّ',
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
      fam_reward_unlocked: 'مفتوحة: هيا نطلبها من أحد الوالدين',
      fam_reward_given: 'تمّ استلامها',
      fam_surprise_title: 'مفاجأة جميلة!',
      fam_surprise_ok: 'شكرًا!',
      fam_task_banner_label: 'المهمة',
      fam_task_leave: 'العودة إلى مهامي',
      fam_celebrate: 'أحسنت! سيراجع أحد الوالدين المهمة، ثم تُضاف النجوم {stars} إلى الجرّة.',
      fam_celebrate_reward: 'أحسنت! سيراجع أحد الوالدين المهمة، ثم تُضاف النجوم {stars} إلى الجرّة وتُفتح المكافأة: {reward}.',
      fam_improve: 'كلمات صحيحة أكثر من المرة السابقة: {n}',
      fam_improve_one: 'كلمات صحيحة أكثر من المرة السابقة: {n}',
      fam_try_again: 'هيا نحاول مرة أخرى عندما نكون جاهزين.',
      fam_dict_shortcut: 'هذا الإملاء يبلغ مستوى نجاح المهمة.',
      fam_confirm_task_now: 'تأكيد المهمة الآن',
      fam_task_confirmed: 'تمّ تأكيد المهمة: أُضيفت النجوم {stars} إلى الجرّة.',
      fam_reward_unlocked_now: 'فُتحت المكافأة: {reward}',
      fam_pin_enter_title: 'قسم الكبار',
      fam_pin_enter_intro: 'يُرجى كتابة رمز الكبار. هذا الرمز قفل للأطفال: يُبقي هذا القسم للكبار.',
      fam_pin_confirm_title: 'تأكيد المهمة',
      fam_pin_confirm_intro: 'يُرجى كتابة رمز الكبار لتأكيد المهمة.',
      fam_pin_label: 'الرمز',
      fam_pin_create_title: 'إنشاء رمز الكبار',
      fam_pin_create_intro: 'يُرجى اختيار رمز من ٤ إلى ٦ أرقام وكتابته مرتين. هذا الرمز قفل للأطفال: يُبقي قسم الكبار للكبار.',
      fam_pin_reset_intro: 'حُذف الرمز، وبقيت البيانات كلها. يُرجى اختيار رمز جديد وكتابته مرتين.',
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
      fam_parent_title: 'قسم الكبار',
      fam_parent_help: 'المديح والمفاجآت تُبقي رغبة الأطفال في التعلّم، والمكافآت أنفع لجهد يراه الطفل بنفسه.',
      fam_parent_sections: 'أجزاء قسم الكبار',
      fam_sec_review: 'للمراجعة',
      fam_sec_tasks: 'المهام',
      fam_sec_rewards: 'المكافآت',
      fam_sec_children: 'الأطفال',
      fam_sec_settings: 'الإعدادات',
      fam_placeholder: 'هذا القسم قيد الإعداد.',
      fam_parent_close: 'إغلاق قسم الكبار',
      fam_privacy_line: 'كل ما هنا يبقى على هذا الجهاز.',
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
      fam_status_assigned: 'مطلوبة',
      fam_status_ready: 'بانتظار المراجعة',
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
      fam_err_quran_phrase_task: 'جزء من هذا النص آية من القرآن الكريم (مثل البسملة)، والتطبيق لا يقرأ القرآن الكريم بصوت مسموع أبدًا، لذلك لا يصلح النص لمهمة إملاء، ولكن يصلح لمهمة تسميع كلمة بكلمة.',
      fam_err_quran_meaning_task: 'في هذا النص كلمات من القرآن الكريم (مثل البسملة)، لذلك يُسمَّع كلمة بكلمة فقط. يُرجى اختيار «كلمة بكلمة».',
      fam_err_offline: 'تعذّر التحقّق من النص: الخادم غير متاح. بقي النموذج كما هو، ويُرجى المحاولة مرة أخرى عند عودة الخادم.',
      fam_err_quran_range: 'يُرجى اختيار آيات صحيحة: خمسون آية على الأكثر، داخل السورة.',
      fam_err_due: 'يُرجى اختيار تاريخ صحيح.',
      fam_page_has_quran: 'يبدو أن هذه الصفحة تحتوي على نص من القرآن الكريم. للقرآن الكريم، يُرجى إنشاء مهمة من نوع «القرآن الكريم».',
      fam_child_add: 'إضافة طفل',
      fam_child_new_title: 'طفل جديد',
      fam_child_edit_title: 'تعديل ملف الطفل',
      fam_remove: 'حذف',
      fam_child_remove_q: 'حذف ملف {name}؟ تُحذف أيضًا كل المهام والنجوم والمكافآت الخاصة بهذا الملف على هذا الجهاز، ولا يمكن التراجع عن ذلك.',
      fam_child_removed: 'تمّ حذف الملف وكل بياناته.',
      fam_child_saved: 'تمّ الحفظ.',
      fam_quran_title: 'سورة {name} {from}–{to}',
    },
  };

  const LANG_NAMES = { en: 'English', fr: 'Français', ar: 'العربية' };
  const KIND_ICONS = { recite: 'i-mic', dictation: 'i-pencil', quran: 'i-book' };
  const PARENT_SECTIONS = ['review', 'tasks', 'rewards', 'children', 'settings'];
  const MAX_AYAT = 50;
  const STAR = '⭐';

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
    parentOpen: false, // the parent area was unlocked; leaving it locks it again
    section: 'tasks',
    task: null, // {id, kind} of the task being done
    setupLang: null,
    setupChildLangTouched: false,
    ptChildId: null, // the child whose tasks the parent area shows
    taskForm: null, // {id: taskId | null, childId, token}
    childForm: null, // {id: childId | null}
    removing: null, // childId waiting for the remove confirmation
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

  /** Apply a rewards.js operation (doc -> doc) and save it. Throws what it throws. */
  function update(fn) {
    const next = fn(store.doc, nowIso());
    commit(next);
    return next;
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
      store.doc = null;
      store.raw = null;
      session.childId = null;
      session.parentOpen = false;
      if (app.taskRunning()) app.leaveTask();
      syncApp();
      app.go('start');
      return;
    }
    const v = R.validateDoc(raw);
    if (!v.ok) return; // keep what this tab has; the next save writes it back
    store.doc = v.doc;
    store.raw = raw;
    afterExternalChange();
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
    app.setConsent({ consent: !!(d && d.parent.consentAt), aiConsent: !!(d && d.parent.aiConsentAt) });
    const c = activeChild();
    app.setChild(c ? { id: c.id, nickname: c.nickname, age: c.age, lang: c.lang, quran: c.quran } : null);
    if (c && ['home', 'prepare', 'recite', 'dictation', 'quran'].includes(app.screen())) app.setUiLang(c.lang);
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

  const CHILD_SCREENS = ['home', 'prepare', 'recite', 'dictation', 'quran'];

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
    else if (screen === 'parent') renderParent();
    if (session.task) renderBanner();
  }

  function leave(screen) {
    if (screen === 'parent') {
      session.parentOpen = false; // the PIN is asked again next time
      closeTaskForm();
      closeChildForm();
      hideRemoveConfirm();
    }
  }

  /** The visible family screen again (after a change, or in another language). */
  function redraw() {
    const screen = app.screen();
    if (screen === 'who') renderWho();
    else if (screen === 'home') renderHome();
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
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      submitSetup();
    });
    form.hidden = false;
  }

  function renderSetup() {
    $('#setup-form').hidden = !!store.doc;
  }

  async function submitSetup() {
    if (store.doc) return;
    const status = $('#setup-status');
    const btn = $('#btn-start');
    const pin1 = $('#setup-pin').value;
    const pin2 = $('#setup-pin2').value;
    const nickname = $('#nickname').value.trim();
    const fail = (key, focus) => {
      app.setStatus(status, key, null, { error: true });
      if (focus) focus.focus();
    };
    if (!R.isValidPin(pin1)) return fail('fam_err_pin_format', $('#setup-pin'));
    if (R.normalizePin(pin1) !== R.normalizePin(pin2)) {
      $('#setup-pin2').value = '';
      return fail('fam_err_pin_same', $('#setup-pin2'));
    }
    if (!nickname) return fail('fam_err_nickname', $('#nickname'));
    const consent = $('#consent').checked;
    app.setStatus(status, 'fam_saving');
    btn.disabled = true;
    let doc;
    let child;
    try {
      const now = nowIso();
      doc = R.emptyDoc(now, { uiLang: session.setupLang });
      doc = R.updateParent(doc, { consent, aiConsent: consent }, now);
      doc = await R.setPin(doc, pin1, now);
      const r = R.addChild(doc, { nickname, age: $('#age').value, lang: $('#child-lang').value, avatar: pickedEmoji($('#setup-avatars')) }, now);
      doc = r.doc;
      child = r.child;
    } catch (err) {
      btn.disabled = false;
      if (isRewardsError(err, 'unavailable')) return fail('fam_err_crypto');
      if (isRewardsError(err, 'bad_input') && err.field === 'nickname') return fail('fam_err_nickname', $('#nickname'));
      return fail('error_generic');
    }
    btn.disabled = false;
    if (store.doc) return; // another tab finished a setup meanwhile: keep its document
    $('#setup-pin').value = '';
    $('#setup-pin2').value = '';
    app.clearStatus(status);
    commit(doc);
    session.childId = child.id;
    syncApp();
    app.go('home');
  }

  // ===========================================================================
  // Who is learning?
  // ===========================================================================

  function renderWho() {
    const list = $('#who-list');
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
    fillTaskList($('#home-todo'), $('#home-todo-empty'), sum.todo, 'todo');
    fillTaskList($('#home-wait'), $('#home-wait-empty'), sum.waiting, 'waiting');
    fillTaskList($('#home-done'), $('#home-done-empty'), sum.done, 'done');
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
      box.append(el('div', { class: 'card celebrate surprise' }, [
        el('p', { class: 'celebrate-title' }, t('fam_surprise_title')),
        el('p', { class: 'surprise-reward' }, [el('span', { class: 'big-emoji', 'aria-hidden': 'true' }, s.reward.emoji), ' ', userText(s.reward.text)]),
        ok,
      ]));
    }
  }

  function fillTaskList(list, empty, tasks, section) {
    list.textContent = '';
    for (const task of tasks) list.append(taskCard(task, section));
    empty.hidden = tasks.length > 0;
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
      lines.push(el('p', { class: 'task-pass' }, t('fam_pass_line', { rule: t('fam_pass_' + R.passRule(task)) })));
    }
    if (task.due && section === 'todo') lines.push(el('p', { class: 'task-due' }, t('fam_due', { date: fmtDay(task.due) })));
    if (task.sentBackNote && section === 'todo') {
      lines.push(el('p', { class: 'task-note' }, [t('fam_note_label') + ' ', userText(task.sentBackNote)]));
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
    pass.textContent = t('fam_pass_line', { rule: t('fam_pass_' + R.passRule(task)) });
  }

  /** A check result of the running task: record it, then show what it means. */
  function onTaskResult(taskId, res, node) {
    if (!store.doc || !node) return;
    let out;
    try {
      out = R.recordAttempt(store.doc, taskId, res, nowIso());
    } catch (err) {
      // A result that does not fit the task (it should not happen) is not counted.
      if (isRewardsError(err)) return;
      throw err;
    }
    commit(out.doc);
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
    if (imp !== null && imp > 0) node.append(el('p', { class: 'improve' }, tNodes(imp === 1 ? 'fam_improve_one' : 'fam_improve', { n: imp })));
    if (passed) {
      const vars = { stars: starsText(task.stars) };
      if (task.reward) vars.reward = { user: rewardLabel(task.reward) };
      const card = el('div', { class: 'celebrate' }, [el('p', { class: 'celebrate-title' }, tNodes(task.reward ? 'fam_celebrate_reward' : 'fam_celebrate', vars))]);
      node.append(card);
      // Dictation: the parent is here (they confirmed the result): a shortcut to confirm the task.
      if (task.kind === 'dictation' && task.status === 'ready') card.append(dictationShortcut(task.id));
    } else {
      node.append(el('p', { class: 'try-again' }, t('fam_try_again')));
    }
    node.hidden = false;
  }

  function dictationShortcut(taskId) {
    const box = el('div', { class: 'shortcut' });
    const btn = el('button', { type: 'button', class: 'btn btn-primary', id: 'btn-confirm-task-now' }, [svgIcon('i-lock'), el('span', null, t('fam_confirm_task_now'))]);
    const status = el('p', { class: 'status', role: 'status', 'aria-live': 'polite' });
    btn.addEventListener('click', async () => {
      const ok = await pinDialog('confirm');
      if (!ok) return;
      let task;
      try {
        update((d, now) => R.confirmTask(d, taskId, 'app_pass', now));
        task = R.getTask(store.doc, taskId);
      } catch (err) {
        app.setStatus(status, 'error_generic', null, { error: true });
        return;
      }
      box.textContent = '';
      box.append(el('p', { class: 'confirmed' }, tNodes('fam_task_confirmed', { stars: starsText(task.stars) })));
      if (task.reward) box.append(el('p', { class: 'confirmed' }, tNodes('fam_reward_unlocked_now', { reward: { user: rewardLabel(task.reward) } })));
      box.setAttribute('tabindex', '-1');
      box.focus();
    });
    box.append(el('p', { class: 'tag-parent' }, t('parent_tag')), el('p', null, t('fam_dict_shortcut')), btn, status);
    return box;
  }

  // ===========================================================================
  // The PIN dialog: create (twice), enter, "Forgot PIN" behind a parental gate
  // ===========================================================================

  const pin = { mode: null, purpose: null, resolve: null, busy: false, timer: null, until: 0, gate: null, intro: null };

  /** Ask for the PIN ('unlock' the parent area or 'confirm' a task). Resolves to true when given. */
  function pinDialog(purpose) {
    return new Promise((resolve) => {
      if (!store.doc) return resolve(false);
      if (pin.resolve) pin.resolve(false);
      pin.resolve = resolve;
      pin.purpose = purpose;
      const dlg = $('#pin-dialog');
      setPinMode(store.doc.parent.pin ? 'enter' : 'create', null);
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
    const p1 = $('#pin-1');
    const p2 = $('#pin-2');
    p1.value = '';
    p2.value = '';
    p1.disabled = false;
    $('#pin-ok').disabled = false;
    pinStatus(null);
    if (mode === 'enter') {
      $('#pin-title').textContent = pt(confirm ? 'fam_pin_confirm_title' : 'fam_pin_enter_title');
      $('#pin-intro').textContent = pt(intro || (confirm ? 'fam_pin_confirm_intro' : 'fam_pin_enter_intro'));
      $('#pin-1-label').textContent = pt('fam_pin_label');
      p1.type = 'password';
      $('#pin-f2').hidden = true;
      $('#pin-ok').textContent = pt(confirm ? 'fam_confirm' : 'fam_unlock');
      $('#pin-forgot').hidden = false;
      $('#pin-forgot').textContent = pt('fam_forgot');
      const st = R.pinStatus(store.doc, nowIso());
      if (st.locked) showLocked(st.retryInMs);
    } else if (mode === 'create') {
      $('#pin-title').textContent = pt('fam_pin_create_title');
      $('#pin-intro').textContent = pt(intro || 'fam_pin_create_intro');
      $('#pin-1-label').textContent = pt('fam_pin_new');
      $('#pin-2-label').textContent = pt('fam_pin_again');
      p1.type = 'password';
      $('#pin-f2').hidden = false;
      $('#pin-ok').textContent = pt('fam_create');
      $('#pin-forgot').hidden = true;
    } else {
      // The parental gate: a multiplication written in words, answered in digits.
      pin.gate = { a: randomInt(3, 9), b: randomInt(3, 9) };
      $('#pin-title').textContent = pt('fam_gate_title');
      $('#pin-intro').textContent = pt('fam_gate_intro');
      $('#pin-1-label').textContent = pt('fam_gate_q', { a: pt('fam_n' + pin.gate.a), b: pt('fam_n' + pin.gate.b) });
      p1.type = 'text';
      $('#pin-f2').hidden = true;
      $('#pin-ok').textContent = pt('fam_gate_check');
      $('#pin-forgot').hidden = true;
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
    const lang = parentLang();
    pinStatus('fam_pin_locked', { time: fmtWait(ms, lang) }, true);
    pin.timer = setInterval(() => {
      const left = pin.until - Date.now();
      const s = $('#pin-status');
      if (left <= 0) {
        stopPinTimer();
        $('#pin-1').disabled = false;
        $('#pin-ok').disabled = false;
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
      const answer = app.asciiDigits(v1).replace(/\s+/g, '');
      if (/^\d+$/.test(answer) && Number(answer) === pin.gate.a * pin.gate.b) {
        update((d, now) => R.clearPin(d, now)); // the PIN goes; all the data stays
        setPinMode('create', 'fam_pin_reset_intro');
        p1.focus();
      } else {
        setPinMode('gate');
        pinStatus('fam_gate_wrong', null, true);
        p1.focus();
      }
      return;
    }
    pin.busy = true;
    try {
      if (pin.mode === 'create') {
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
        const doc = await R.setPin(store.doc, v1, nowIso());
        commit(doc);
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
      const r = await R.verifyPin(store.doc, v1, nowIso());
      commit(r.doc); // the backoff lives in the document: always saved
      if (r.ok) {
        closePin(true);
        return;
      }
      p1.value = '';
      if (r.code === 'locked' || r.lockedUntil) showLocked(r.retryInMs);
      else if (r.attemptsLeft > 0) pinStatus('fam_pin_wrong', { n: r.attemptsLeft }, true);
      else pinStatus('fam_pin_wrong_last', null, true);
      if (!p1.disabled) p1.focus();
    } catch (err) {
      if (isRewardsError(err, 'unavailable')) pinStatus('fam_err_crypto', null, true);
      else if (isRewardsError(err, 'bad_state') && !store.doc.parent.pin) setPinMode('create', null);
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

  async function openParent() {
    if (!store.doc) return;
    const ok = await pinDialog('unlock');
    if (!ok) return;
    session.parentOpen = true;
    // Without consent the microphone stays off: the box is in Settings.
    session.section = store.doc.parent.consentAt ? 'tasks' : 'settings';
    app.go('parent');
  }

  function closeParent() {
    session.parentOpen = false;
    app.go(session.childId ? 'home' : 'who');
  }

  function renderParent() {
    if (!store.doc) return;
    for (const tab of $$('#psec-nav .psec-tab')) {
      if (tab.dataset.psec === session.section) tab.setAttribute('aria-current', 'true');
      else tab.removeAttribute('aria-current');
    }
    for (const sec of $$('#screen-parent .psec')) sec.hidden = sec.dataset.psec !== session.section;
    if (session.section === 'tasks') renderTasks();
    else if (session.section === 'children') renderChildren();
    else if (session.section === 'settings') renderSettings();
  }

  function showSection(name) {
    if (!PARENT_SECTIONS.includes(name)) return;
    if (name !== session.section) {
      closeTaskForm();
      closeChildForm();
      hideRemoveConfirm();
    }
    session.section = name;
    renderParent();
    const h = $('#screen-parent .psec[data-psec="' + name + '"] h2');
    if (h) h.focus();
  }

  // --- Settings (the consent box; the rest is the next step) -----------------

  function renderSettings() {
    $('#settings-consent').checked = !!store.doc.parent.consentAt;
  }

  function onSettingsConsent(e) {
    const on = e.target.checked;
    try {
      update((d, now) => R.updateParent(d, { consent: on, aiConsent: on }, now));
    } catch (err) {
      e.target.checked = !on;
      return;
    }
    syncApp();
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
    const select = $('#pt-child');
    const children = doc.children;
    if (!children.some((c) => c.id === session.ptChildId)) {
      session.ptChildId = children.some((c) => c.id === session.childId) ? session.childId : children.length ? children[0].id : null;
    }
    select.textContent = '';
    for (const c of children) select.append(el('option', { value: c.id }, c.avatar + ' ' + c.nickname));
    if (session.ptChildId) select.value = session.ptChildId;
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
    const order = { assigned: 0, ready: 1, done: 2 };
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

  function parentTaskItem(task) {
    const actions = R.taskActions(task);
    const buttons = [];
    if (actions.edit) {
      const b = el('button', { type: 'button', class: 'btn btn-small', 'data-edit-task': task.id }, t('fam_edit'));
      b.addEventListener('click', () => openTaskForm(task.id));
      buttons.push(b);
    }
    if (actions.archive) {
      const b = el('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', 'data-archive-task': task.id }, t('fam_archive'));
      b.addEventListener('click', () => archive(task.id));
      buttons.push(b);
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
      el('div', { class: 'ptask-actions' }, buttons),
    ]);
  }

  function archive(taskId) {
    try {
      update((d, now) => R.archiveTask(d, taskId, now));
    } catch (err) {
      app.setStatus($('#pt-status'), 'error_generic', null, { error: true });
      return;
    }
    if (session.taskForm && session.taskForm.id === taskId) closeTaskForm();
    renderTasks();
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

  /** Show the fields of the chosen kind (and mode). */
  function updateFormKind() {
    const kind = formKind();
    const contextual = kind === 'recite' && formMode() === 'contextual';
    $('#tf-text-group').hidden = kind === 'quran';
    $('#tf-mode').hidden = kind !== 'recite';
    $('#tf-quran-group').hidden = kind !== 'quran';
    $('#tf-pass').hidden = contextual;
    $('#tf-pass-meaning').hidden = !contextual;
    app.setTextLang($('#tf-text'), $('#tf-lang').value);
    if (kind === 'quran') fillSurahSelect();
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
    for (const id of ['#tf-status', '#tf-photo-status', '#tf-quran-note', '#tf-surah-status']) app.clearStatus($(id));
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

  /** The text of the task checked by the server in the mode of the task: null or an error key. */
  async function checkTaskText(text, lang, kind, mode) {
    const checkMode = kind === 'dictation' ? 'dictation' : mode;
    try {
      const res = await app.checkText(text, lang, checkMode);
      return res.words === 0 ? 'error_no_words' : null;
    } catch (err) {
      if (!err || err.name !== 'ApiError') return 'error_generic';
      if (err.status === 0) return 'fam_err_offline';
      if (app.isPhraseRefusal(err)) return 'fam_err_quran_phrase_task';
      if (err.code === 'quran_text') {
        if (checkMode !== 'contextual') return 'fam_err_quran_task';
        // Refused by meaning: is it Quran text, or a text with Quran words (the basmala)?
        try {
          await app.checkText(text, lang, 'strict');
          return 'fam_err_quran_meaning_task';
        } catch (e2) {
          return 'fam_err_quran_task';
        }
      }
      return app.errorInfo(err).key;
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
      if (focus) focus.focus();
    };
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
      if (!text) return fail('text_empty', $('#tf-text'));
      content.text = text;
      content.lang = lang;
      if (kind === 'recite') content.mode = formMode();
      const unchanged = task && task.text === text && task.lang === lang && (kind !== 'recite' || task.mode === content.mode);
      if (!unchanged) {
        // Saving needs a successful check of the text, in the mode of the task.
        app.setStatus(status, 'checking_text');
        $('#tf-save').disabled = true;
        const key = await checkTaskText(text, lang, kind, content.mode);
        if (!session.taskForm || session.taskForm.token !== token) return; // closed meanwhile
        $('#tf-save').disabled = false;
        if (key) return fail(key, key === 'fam_err_offline' ? null : $('#tf-text'));
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
    renderTasks();
    app.setStatus($('#pt-status'), 'fam_task_saved');
    $('#pt-new').focus();
  }

  /** A photo of the page read into the task text, with the review of Prepare. */
  async function readTaskPhoto(input) {
    const file = app.takeFile(input);
    if (!file || !app.isOpen('prep-photo')) return;
    const status = $('#tf-photo-status');
    const note = $('#tf-quran-note');
    app.clearStatus(note);
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
      if (res.needs_manual || !text.trim()) app.setStatus(status, 'page_needs_manual');
      else if (res.notes) app.setStatus(status, 'page_read_ok', null, { detail: String(res.notes) });
      else app.setStatus(status, 'page_read_ok');
      if (res.contains_quran === true) app.setStatus(note, 'fam_page_has_quran');
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
    $('#settings-consent').addEventListener('change', onSettingsConsent);
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
      app.clearStatus($('#pt-status'));
      renderTasks();
    });
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
    $('#tf-lang').addEventListener('change', () => app.setTextLang($('#tf-text'), $('#tf-lang').value));
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
    initParent();
    $('#data-notice-close').addEventListener('click', () => {
      $('#data-notice').hidden = true;
    });
    for (const id of ['#btn-who-parents', '#btn-home-parents']) $(id).addEventListener('click', openParent);
    $('#btn-switch-child').addEventListener('click', () => {
      session.childId = null;
      syncApp();
      app.go('who');
    });
    window.addEventListener('storage', onStorage);
    syncApp();
    app.setHooks({ route, langFor, enter, leave, onQuranPrefs, onLanguage: redraw, onHealth: () => {} });
  }

  window.MommyFamily = Object.freeze({ attach });
  if (window.MommyApp) attach(window.MommyApp);
})();
