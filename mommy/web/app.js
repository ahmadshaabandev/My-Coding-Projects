/*
 * app.js: the Mommy web client (vanilla JS, no framework, no external requests).
 *
 * Screens: start (AI disclosure, parent consent, child profile), prepare a page (parent),
 * recite, dictation, and the Quran. The HTTP API is described in docs/CONTRACT.md.
 *
 * Privacy rules followed here:
 *   - Audio and photos live only in memory: a Blob is uploaded and then dropped. Nothing
 *     is put in localStorage except the child profile and a few display preferences.
 *   - Photos are resized in the browser (long edge <= 2000 px) and re-encoded as JPEG,
 *     which drops EXIF metadata, before upload.
 *   - The microphone and camera stay disabled until a parent ticks the consent box.
 *   - Quran text is shown exactly as the server sends it (verbatim Tanzil). Quran
 *     feedback is shown as text only and is never sent to speech synthesis.
 */
(function () {
  'use strict';

  // ===========================================================================
  // UI strings (en / fr / ar)
  // ===========================================================================

  const STRINGS = {
    en: {
      doc_title: 'Mommy — AI reading tutor',
      skip: 'Skip to content',
      badge: 'AI tutor — not a person',
      nav_label: 'Main',
      nav_profile: 'Profile and settings',
      nav_prepare: 'Prepare',
      nav_recite: 'Recite',
      nav_dictation: 'Dictation',
      nav_quran: 'Quran',
      start_title: "Hello! I'm Mommy.",
      start_lead: 'I help you practise reading aloud and dictation.',
      disclosure_title: 'Good to know',
      disclosure_text: 'Mommy is a computer program (an AI). It is not a person, and it is not your mum or dad. It can make mistakes, so a grown-up should stay close.',
      profile_title: 'Child profile',
      profile_note: 'Saved only on this device.',
      nickname: 'Nickname',
      nickname_ph: 'e.g. Sami',
      age: 'Age',
      age_6_9: '6–9 years',
      age_10_13: '10–13 years',
      age_14_18: '14–18 years',
      ui_lang: 'Language',
      consent_title: 'For the parent',
      consent_label: "I am this child's parent or guardian. I allow Mommy to use the microphone and the camera.",
      consent_privacy: 'Recordings and photos are checked in memory and never saved.',
      consent_claude: 'Some things are sent to Claude, an AI service made by Anthropic: photos of pages and of handwriting, so that it can read them; the page text and a transcript of what your child says (in “The meaning” mode), so that it can judge the meaning; and the words your child got wrong, so that it can word the feedback. The recordings themselves are not sent.',
      consent_offline: 'Offline mode: nothing leaves this computer, and you type the texts yourself.',
      start_button: "Let's start",
      consent_needed: 'A parent must tick the consent box on the start screen before the microphone or camera can be used.',
      consent_needed_ai: 'Checking uses the online AI: a parent must first tick the consent box on the start screen.',
      server_down: "I can't reach the Mommy server. Is it running?",
      checking_server: 'Checking the server…',
      retry: 'Try again',
      no_asr: 'Listening is not available: the speech recognition model is not installed.',
      no_tts: 'The voice is not available: the speech model is not installed. A grown-up can read aloud instead.',
      no_brain: 'Reading photos needs the online AI, which is not set up. Please type or paste the text.',
      no_quran: 'The Quran text is not available on this server.',
      no_mic_support: 'This browser cannot record here. Please use a recent browser, on https or localhost.',
      mic_denied: 'The microphone is blocked. Please allow it in the browser settings.',
      mic_missing: 'I could not find a microphone.',
      parent_tag: 'For the grown-up',
      prep_title: 'Prepare a page',
      prep_intro: 'Take a photo of the textbook page, or type or paste the text. Then check it and press “Confirm text”.',
      text_lang: 'Language of the text',
      take_photo: 'Take a photo',
      choose_photo: 'Choose a photo',
      photo_privacy: 'Photos are made smaller on this device and are not kept.',
      reading_page: 'Reading the page…',
      page_read_ok: 'Done. Please check the text carefully and correct it if needed.',
      page_needs_manual: 'The page could not be read automatically. Please type or paste the text.',
      page_notes: 'Note: {notes}',
      page_has_quran: 'This page seems to contain Quran text. Please practise the Quran in the Quran section.',
      photo_bad: "I couldn't open this picture. Please try a JPEG or PNG photo.",
      page_text_label: 'Page text',
      page_text_ph: 'Type or paste the text here…',
      mode_label: 'Reciting mode',
      mode_strict: 'Word by word',
      mode_strict_hint: 'Every word must be right.',
      mode_contextual: 'The meaning',
      mode_contextual_hint: 'Own words are fine if the meaning is right.',
      mode_contextual_offline: 'Without the online AI, the meaning check is only approximate.',
      confirm_text: 'Confirm text',
      checking_text: 'Checking the text…',
      text_confirmed: 'Text confirmed. Your child can now recite it or do a dictation.',
      text_confirmed_ar: 'Text confirmed. It is written in Arabic, so its language was set to Arabic.',
      text_not_arabic: 'This text is not written in Arabic. Please choose the language of the text.',
      text_confirmed_no_dictation: 'Text confirmed for reciting. It cannot be used for dictation: part of it is an ayah of the Quran (for example the basmala), and the app never reads the Quran aloud.',
      text_empty: 'Please type or paste some text first.',
      text_changed: 'The text has changed. Press “Confirm text” again.',
      go_recite: 'Go to Recite',
      go_dictation: 'Go to Dictation',
      recite_title: 'Recite',
      hello_name: 'Hi {name}!',
      hello_anon: 'Hi there!',
      need_page: 'Ask a grown-up to prepare a page first.',
      open_prepare: 'Prepare a page',
      recite_intro: 'Read the text aloud. Press the big button to start, and press it again when you finish.',
      mode_is: 'Mode: {mode}',
      rec_start: 'Start',
      rec_stop: "I'm done",
      rec_wait: 'Wait…',
      rec_time: '{sec} s',
      listening: "I'm listening…",
      checking: 'Let me check…',
      max_reached: "That's the longest I can listen to (2 minutes).",
      heard_label: 'What I heard',
      say_again: 'Say that again',
      listen: 'Listen',
      press_listen: 'Press “Listen” to hear it.',
      too_quiet: 'I could hardly hear you. Come a little closer and speak up.',
      too_short: 'That was very short. Press the button, read the whole text, then press it again.',
      score: 'Words right: {ok} of {n}',
      legend_match: 'right',
      legend_sub: 'heard differently',
      legend_sub_written: 'written differently',
      legend_del: 'skipped',
      legend_ins: 'extra word',
      sr_heard: 'heard:',
      sr_written: 'written:',
      sr_skipped: 'skipped',
      sr_extra: 'extra word:',
      verdict_same_meaning: 'Same meaning',
      verdict_nearly: 'Nearly the same meaning',
      verdict_partly: 'Partly right',
      verdict_different: 'Different meaning',
      verdict_unclear: 'I could not hear well',
      missing_ideas: 'Ideas to add',
      wrong_ideas: 'Ideas to fix',
      approximate: 'Approximate check (offline)',
      dict_title: 'Dictation',
      dict_intro: 'Get a pencil and paper. I will say the text slowly, one small piece at a time.',
      dict_start: 'Start the dictation',
      preparing: 'Getting ready…',
      phrase_n: 'Part {i} of {n}',
      voice_unclear: 'The voice may be unclear in this part. Press “Repeat” to hear a new take, or show the words.',
      press_repeat: 'Press “Repeat” to hear it.',
      repeat: 'Repeat',
      next: 'Next',
      finish: "I've finished",
      show_phrase: 'Show the words (grown-up)',
      hide_phrase: 'Hide the words',
      no_phrases: 'There is nothing to dictate in this text.',
      dict_check_title: 'Check the writing',
      dict_check_intro: "Take a photo of your child's paper, or type exactly what they wrote — mistakes included.",
      written_label: 'What your child wrote',
      check_writing: 'Check',
      reading_writing: 'Reading the handwriting…',
      written_empty: 'Please type what your child wrote, or take a photo.',
      needs_manual_writing: 'Reading handwriting needs the online AI. Please type what your child wrote.',
      parent_review_title: 'Please check before your child sees it',
      parent_review_intro: 'The AI may misread handwriting. Fix the text below if needed and check again, then confirm.',
      illegible: 'The writing was hard to read. Please check it carefully.',
      read_text_label: 'What was read',
      uncertain: 'Not sure about: {words}',
      recheck: 'Check again with this text',
      review_stale: 'You changed the text. Press “Check again with this text” before you confirm.',
      confirm_result: 'Confirm result',
      dict_result_title: 'Your dictation',
      new_dictation: 'New dictation',
      quran_title: 'Quran',
      juz_amma_only: "Juz' Amma only (surahs 78–114)",
      surah: 'Surah',
      from_ayah: 'From ayah',
      to_ayah: 'To ayah',
      range_capped: 'At most 50 ayat at a time.',
      quran_mode: 'How do you want to recite?',
      mode_looking: 'Recite looking',
      mode_memory: 'From memory',
      quran_text_hidden: 'The text is hidden. Recite from memory!',
      hint: 'Hint: next word',
      hint_none: 'No more words.',
      quran_rec: 'Start reciting',
      loading: 'Loading…',
      where_am_i: 'Where am I?',
      where_stop: 'Stop and find',
      only_this_surah: 'Search only this surah',
      locating: 'Looking for the place…',
      found_at: 'Surah {name} ({s}), ayah {a}',
      not_found: "I couldn't find it. Try reciting a few more words.",
      go_there: 'Go there',
      first_error_at: 'Look again at ayah {a}.',
      rehide: 'Hide the text and try again',
      ayah_label: 'Ayah {a}',
      error_generic: 'Something went wrong. Please try again.',
      error_too_big: 'That is too big for me. Please try something shorter or smaller.',
      error_unavailable: 'This is not available right now.',
      error_quran_text: 'This text is from the Quran. Please practise it in the Quran section.',
      error_quran_phrase: 'Part of this text is an ayah of the Quran (for example the basmala), and the app never reads the Quran aloud, so this text cannot be used for dictation. It can still be recited.',
      error_unreadable_text: 'Some words could not be read and are marked [?]. Please type them in place of [?] first.',
      error_lang_mismatch: 'This text is not in the language chosen. Please choose the language of the text.',
      error_text_too_long: 'This text is too long. Please use a shorter text.',
      error_no_words: 'There are no words to check in this text.',
      go_quran: 'Go to the Quran section',
    },

    fr: {
      doc_title: 'Mommy — tuteur de lecture IA',
      skip: 'Aller au contenu',
      badge: 'Tuteur IA — pas une personne',
      nav_label: 'Principal',
      nav_profile: 'Profil et réglages',
      nav_prepare: 'Préparer',
      nav_recite: 'Réciter',
      nav_dictation: 'Dictée',
      nav_quran: 'Coran',
      start_title: 'Bonjour ! Je suis Mommy.',
      start_lead: "Je t'aide à t'entraîner à lire à voix haute et à faire des dictées.",
      disclosure_title: 'Bon à savoir',
      disclosure_text: "Mommy est un programme informatique (une IA). Ce n'est pas une personne, ni ta maman ou ton papa. Mommy peut se tromper : un adulte doit rester tout près.",
      profile_title: "Profil de l'enfant",
      profile_note: 'Enregistré uniquement sur cet appareil.',
      nickname: 'Surnom',
      nickname_ph: 'ex. Sami',
      age: 'Âge',
      age_6_9: '6 à 9 ans',
      age_10_13: '10 à 13 ans',
      age_14_18: '14 à 18 ans',
      ui_lang: 'Langue',
      consent_title: 'Pour le parent',
      consent_label: "Je suis parent de cet enfant ou j'en ai la responsabilité légale. J'autorise Mommy à utiliser le micro et l'appareil photo.",
      consent_privacy: 'Les enregistrements et les photos sont traités en mémoire et ne sont jamais enregistrés.',
      consent_claude: "Certaines données sont envoyées à Claude, un service d'IA d'Anthropic : les photos de pages et d'écriture, pour qu'il puisse les lire ; le texte de la page et une transcription de ce que dit votre enfant (en mode « Le sens »), pour qu'il juge le sens ; et les mots où votre enfant a fait une erreur, pour qu'il rédige le message. Les enregistrements eux-mêmes ne sont pas envoyés.",
      consent_offline: 'Mode hors ligne : rien ne quitte cet ordinateur, et vous tapez les textes vous-même.',
      start_button: 'On commence',
      consent_needed: "Un parent doit cocher la case d'accord sur l'écran d'accueil avant d'utiliser le micro ou l'appareil photo.",
      consent_needed_ai: "La vérification utilise l'IA en ligne : un parent doit d'abord cocher la case d'accord sur l'écran d'accueil.",
      server_down: "Je n'arrive pas à joindre le serveur Mommy. Est-il lancé ?",
      checking_server: 'Vérification du serveur…',
      retry: 'Réessayer',
      no_asr: "L'écoute n'est pas disponible : le modèle de reconnaissance vocale n'est pas installé.",
      no_tts: "La voix n'est pas disponible : le modèle de synthèse vocale n'est pas installé. Un adulte peut lire à voix haute.",
      no_brain: "La lecture des photos demande l'IA en ligne, qui n'est pas configurée. Tapez ou collez le texte.",
      no_quran: "Le texte du Coran n'est pas disponible sur ce serveur.",
      no_mic_support: "Ce navigateur ne peut pas enregistrer ici. Utilisez un navigateur récent, en https ou sur localhost.",
      mic_denied: 'Le micro est bloqué. Autorisez-le dans les réglages du navigateur.',
      mic_missing: "Je n'ai pas trouvé de micro.",
      parent_tag: "Pour l'adulte",
      prep_title: 'Préparer une page',
      prep_intro: 'Prenez la page en photo, ou tapez ou collez le texte. Vérifiez-le, puis appuyez sur « Valider le texte ».',
      text_lang: 'Langue du texte',
      take_photo: 'Prendre une photo',
      choose_photo: 'Choisir une photo',
      photo_privacy: 'Les photos sont réduites sur cet appareil et ne sont pas conservées.',
      reading_page: 'Lecture de la page…',
      page_read_ok: "C'est fait. Vérifiez bien le texte et corrigez-le si besoin.",
      page_needs_manual: "La page n'a pas pu être lue automatiquement. Tapez ou collez le texte.",
      page_notes: 'Remarque : {notes}',
      page_has_quran: 'Cette page semble contenir un texte du Coran. Pour le Coran, utilisez la section Coran.',
      photo_bad: "Je n'arrive pas à ouvrir cette image. Essayez une photo JPEG ou PNG.",
      page_text_label: 'Texte de la page',
      page_text_ph: 'Tapez ou collez le texte ici…',
      mode_label: 'Mode de récitation',
      mode_strict: 'Mot à mot',
      mode_strict_hint: 'Chaque mot doit être juste.',
      mode_contextual: 'Le sens',
      mode_contextual_hint: 'Ses propres mots, si le sens est juste.',
      mode_contextual_offline: "Sans l'IA en ligne, la vérification du sens est seulement approximative.",
      confirm_text: 'Valider le texte',
      checking_text: 'Vérification du texte…',
      text_confirmed: 'Texte validé. Votre enfant peut maintenant le réciter ou faire une dictée.',
      text_confirmed_ar: "Texte validé. Il est écrit en arabe : sa langue a été réglée sur l'arabe.",
      text_not_arabic: "Ce texte n'est pas écrit en arabe. Choisissez la langue du texte.",
      text_confirmed_no_dictation: "Texte validé pour la récitation. Il ne peut pas servir à une dictée : une partie est un verset du Coran (par exemple la basmala), et l'application ne lit jamais le Coran à voix haute.",
      text_empty: "Tapez ou collez d'abord un texte.",
      text_changed: 'Le texte a changé. Appuyez de nouveau sur « Valider le texte ».',
      go_recite: 'Aller à Réciter',
      go_dictation: 'Aller à Dictée',
      recite_title: 'Réciter',
      hello_name: 'Coucou {name} !',
      hello_anon: 'Coucou !',
      need_page: "Demande d'abord à un adulte de préparer une page.",
      open_prepare: 'Préparer une page',
      recite_intro: 'Lis le texte à voix haute. Appuie sur le gros bouton pour commencer, et appuie encore quand tu as fini.',
      mode_is: 'Mode : {mode}',
      rec_start: 'Démarrer',
      rec_stop: "J'ai fini",
      rec_wait: 'Patiente…',
      rec_time: '{sec} s',
      listening: "J'écoute…",
      checking: 'Je vérifie…',
      max_reached: "C'est le plus long que je peux écouter (2 minutes).",
      heard_label: "Ce que j'ai entendu",
      say_again: 'Redis-le',
      listen: 'Écouter',
      press_listen: 'Appuie sur « Écouter » pour l’entendre.',
      too_quiet: "Je t'entends à peine. Approche-toi un peu et parle plus fort.",
      too_short: "C'était très court. Appuie sur le bouton, lis tout le texte, puis appuie encore.",
      score: 'Mots justes : {ok} sur {n}',
      legend_match: 'juste',
      legend_sub: 'entendu autrement',
      legend_sub_written: 'écrit autrement',
      legend_del: 'oublié',
      legend_ins: 'mot en plus',
      sr_heard: 'entendu :',
      sr_written: 'écrit :',
      sr_skipped: 'oublié',
      sr_extra: 'mot en plus :',
      verdict_same_meaning: 'Même sens',
      verdict_nearly: 'Presque le même sens',
      verdict_partly: 'En partie',
      verdict_different: 'Sens différent',
      verdict_unclear: "Je n'ai pas bien entendu",
      missing_ideas: 'Idées à ajouter',
      wrong_ideas: 'Idées à corriger',
      approximate: 'Vérification approximative (hors ligne)',
      dict_title: 'Dictée',
      dict_intro: 'Prends un crayon et une feuille. Je vais dire le texte lentement, petit morceau par petit morceau.',
      dict_start: 'Commencer la dictée',
      preparing: 'Je me prépare…',
      phrase_n: 'Morceau {i} sur {n}',
      voice_unclear: "La voix n'est peut-être pas claire pour ce morceau. Appuyez sur « Répéter » pour l'entendre à nouveau, ou montrez les mots.",
      press_repeat: 'Appuie sur « Répéter » pour l’entendre.',
      repeat: 'Répéter',
      next: 'Suivant',
      finish: "J'ai fini",
      show_phrase: 'Montrer les mots (adulte)',
      hide_phrase: 'Cacher les mots',
      no_phrases: "Il n'y a rien à dicter dans ce texte.",
      dict_check_title: "Vérifier l'écriture",
      dict_check_intro: "Prenez la feuille en photo, ou tapez exactement ce que l'enfant a écrit, fautes comprises.",
      written_label: "Ce que l'enfant a écrit",
      check_writing: 'Vérifier',
      reading_writing: "Lecture de l'écriture…",
      written_empty: "Tapez ce que l'enfant a écrit, ou prenez une photo.",
      needs_manual_writing: "La lecture de l'écriture demande l'IA en ligne. Tapez ce que l'enfant a écrit.",
      parent_review_title: "À vérifier avant de montrer à l'enfant",
      parent_review_intro: "L'IA peut mal lire l'écriture. Corrigez le texte ci-dessous si besoin et revérifiez, puis validez.",
      illegible: "L'écriture était difficile à lire. Vérifiez-la bien.",
      read_text_label: 'Ce qui a été lu',
      uncertain: 'Mots incertains : {words}',
      recheck: 'Revérifier avec ce texte',
      review_stale: 'Vous avez modifié le texte. Appuyez sur « Revérifier avec ce texte » avant de valider.',
      confirm_result: 'Valider le résultat',
      dict_result_title: 'Ta dictée',
      new_dictation: 'Nouvelle dictée',
      quran_title: 'Coran',
      juz_amma_only: "Juz' Amma seulement (sourates 78 à 114)",
      surah: 'Sourate',
      from_ayah: 'De l’âyah',
      to_ayah: 'À l’âyah',
      range_capped: '50 âyât au maximum à la fois.',
      quran_mode: 'Comment veux-tu réciter ?',
      mode_looking: 'En regardant',
      mode_memory: 'De mémoire',
      quran_text_hidden: 'Le texte est caché. Récite de mémoire !',
      hint: 'Indice : mot suivant',
      hint_none: "Il n'y a plus de mots.",
      quran_rec: 'Réciter',
      loading: 'Chargement…',
      where_am_i: 'Où en suis-je ?',
      where_stop: 'Stop et chercher',
      only_this_surah: 'Chercher seulement dans cette sourate',
      locating: "Je cherche l'endroit…",
      found_at: 'Sourate {name} ({s}), âyah {a}',
      not_found: "Je n'ai pas trouvé. Essaie de réciter quelques mots de plus.",
      go_there: 'Y aller',
      first_error_at: 'Regarde encore l’âyah {a}.',
      rehide: 'Cacher le texte et recommencer',
      ayah_label: 'Âyah {a}',
      error_generic: 'Un problème est survenu. Réessaie.',
      error_too_big: "C'est trop gros pour moi. Essaie avec quelque chose de plus court ou de plus petit.",
      error_unavailable: "Ce n'est pas disponible pour le moment.",
      error_quran_text: 'Ce texte vient du Coran. Entraînez-vous dans la section Coran.',
      error_quran_phrase: "Une partie de ce texte est un verset du Coran (par exemple la basmala), et l'application ne lit jamais le Coran à voix haute : ce texte ne peut donc pas servir à une dictée. Il peut toujours être récité.",
      error_unreadable_text: "Certains mots n'ont pas pu être lus et sont marqués [?]. Tapez-les d'abord à la place de [?].",
      error_lang_mismatch: "Ce texte n'est pas dans la langue choisie. Choisissez la langue du texte.",
      error_text_too_long: 'Ce texte est trop long. Utilisez un texte plus court.',
      error_no_words: "Il n'y a pas de mots à vérifier dans ce texte.",
      go_quran: 'Aller à la section Coran',
    },

    ar: {
      doc_title: 'Mommy — معلّم قراءة بالذكاء الاصطناعي',
      skip: 'الانتقال إلى المحتوى',
      badge: 'معلّم ذكاء اصطناعي — ليس إنسانًا',
      nav_label: 'القائمة الرئيسية',
      nav_profile: 'الملف والإعدادات',
      nav_prepare: 'تحضير',
      nav_recite: 'تسميع',
      nav_dictation: 'إملاء',
      nav_quran: 'القرآن',
      start_title: 'مرحبًا! أنا Mommy.',
      start_lead: 'أساعدك على التدرّب على القراءة بصوت عالٍ وعلى الإملاء.',
      disclosure_title: 'معلومة مهمّة',
      disclosure_text: 'Mommy برنامج حاسوبي (ذكاء اصطناعي)، وليس إنسانًا، وليس أمّك أو أباك. قد يخطئ، لذلك ينبغي أن يبقى أحد الكبار قريبًا منك.',
      profile_title: 'ملف الطفل',
      profile_note: 'يُحفظ على هذا الجهاز فقط.',
      nickname: 'الاسم المستعار',
      nickname_ph: 'مثلًا: سامي',
      age: 'العمر',
      age_6_9: '٦–٩ سنوات',
      age_10_13: '١٠–١٣ سنة',
      age_14_18: '١٤–١٨ سنة',
      ui_lang: 'اللغة',
      consent_title: 'لوليّ الأمر',
      consent_label: 'أنا أحد والدَي هذا الطفل أو وليّ أمره، وأسمح لـ Mommy باستخدام الميكروفون والكاميرا.',
      consent_privacy: 'تُعالَج التسجيلات والصور في الذاكرة ولا تُحفظ أبدًا.',
      consent_claude: 'تُرسَل بعض البيانات إلى Claude، وهي خدمة ذكاء اصطناعي من شركة Anthropic: صور الصفحات والكتابة لقراءتها، ونص الصفحة ونسخة مكتوبة مما يقوله طفلك (في طريقة «المعنى») للحكم على المعنى، والكلمات التي أخطأ فيها طفلك لصياغة الملاحظات. أمّا التسجيلات الصوتية نفسها فلا تُرسَل.',
      consent_offline: 'وضع بلا اتصال: لا يخرج شيء من هذا الحاسوب، وتُكتب النصوص يدويًا.',
      start_button: 'لنبدأ',
      consent_needed: 'يجب أن يضع وليّ الأمر علامة في خانة الموافقة في شاشة البداية قبل استخدام الميكروفون أو الكاميرا.',
      consent_needed_ai: 'التحقّق يستخدم الذكاء الاصطناعي عبر الإنترنت: يجب أولًا أن يضع وليّ الأمر علامة في خانة الموافقة في شاشة البداية.',
      server_down: 'لا أستطيع الوصول إلى خادم Mommy. هل هو يعمل؟',
      checking_server: 'جارٍ التحقّق من الخادم…',
      retry: 'إعادة المحاولة',
      no_asr: 'الاستماع غير متاح: نموذج التعرّف على الكلام غير مثبّت.',
      no_tts: 'الصوت غير متاح: نموذج النطق غير مثبّت. يمكن لأحد الكبار القراءة بصوت عالٍ بدلًا منه.',
      no_brain: 'قراءة الصور تحتاج إلى الذكاء الاصطناعي عبر الإنترنت، وهو غير مُعدّ. يُرجى كتابة النص أو لصقه.',
      no_quran: 'نص القرآن الكريم غير متاح على هذا الخادم.',
      no_mic_support: 'لا يستطيع هذا المتصفح التسجيل هنا. يُرجى استخدام متصفح حديث عبر https أو localhost.',
      mic_denied: 'الميكروفون محظور. يُرجى السماح به من إعدادات المتصفح.',
      mic_missing: 'لم أجد ميكروفونًا.',
      parent_tag: 'للكبار',
      prep_title: 'تحضير صفحة',
      prep_intro: 'يُرجى تصوير صفحة الكتاب، أو كتابة النص أو لصقه، ثم مراجعته والضغط على «تأكيد النص».',
      text_lang: 'لغة النص',
      take_photo: 'التقاط صورة',
      choose_photo: 'اختيار صورة',
      photo_privacy: 'تُصغَّر الصور على هذا الجهاز ولا تُحفظ.',
      reading_page: 'جارٍ قراءة الصفحة…',
      page_read_ok: 'تمّ. يُرجى مراجعة النص بعناية وتصحيحه إن لزم.',
      page_needs_manual: 'تعذّرت قراءة الصفحة تلقائيًا. يُرجى كتابة النص أو لصقه.',
      page_notes: 'ملاحظة: {notes}',
      page_has_quran: 'يبدو أن هذه الصفحة تحتوي على نص من القرآن الكريم. يُرجى التدرّب على تلاوته في قسم القرآن الكريم.',
      photo_bad: 'لم أستطع فتح هذه الصورة. يُرجى تجربة صورة بصيغة JPEG أو PNG.',
      page_text_label: 'نص الصفحة',
      page_text_ph: 'يُرجى كتابة النص أو لصقه هنا…',
      mode_label: 'طريقة التسميع',
      mode_strict: 'كلمة بكلمة',
      mode_strict_hint: 'يجب أن تكون كل كلمة صحيحة.',
      mode_contextual: 'المعنى',
      mode_contextual_hint: 'يمكن استخدام كلمات أخرى إذا كان المعنى صحيحًا.',
      mode_contextual_offline: 'من دون الذكاء الاصطناعي عبر الإنترنت، يكون التحقّق من المعنى تقريبيًا فقط.',
      confirm_text: 'تأكيد النص',
      checking_text: 'جارٍ التحقّق من النص…',
      text_confirmed: 'تمّ تأكيد النص. يمكن الآن تسميعه أو كتابته إملاءً.',
      text_confirmed_ar: 'تمّ تأكيد النص. وبما أنه مكتوب بالعربية، فقد ضُبطت لغته على العربية.',
      text_not_arabic: 'هذا النص غير مكتوب بالعربية. يُرجى اختيار لغة النص.',
      text_confirmed_no_dictation: 'تمّ تأكيد النص للتسميع. لا يمكن استخدامه في الإملاء: جزء منه آية من القرآن الكريم (مثل البسملة)، والتطبيق لا يقرأ القرآن الكريم بصوت مسموع أبدًا.',
      text_empty: 'يُرجى كتابة نص أو لصقه أولًا.',
      text_changed: 'تغيّر النص. يُرجى الضغط على «تأكيد النص» مرة أخرى.',
      go_recite: 'الانتقال إلى التسميع',
      go_dictation: 'الانتقال إلى الإملاء',
      recite_title: 'التسميع',
      hello_name: 'أهلًا يا {name}!',
      hello_anon: 'أهلًا بك!',
      need_page: 'هيا نطلب من أحد الكبار تحضير صفحة أولًا.',
      open_prepare: 'تحضير صفحة',
      recite_intro: 'هيا نقرأ النص بصوت عالٍ! نضغط الزر الكبير للبدء، ثم نضغطه مرة أخرى عند الانتهاء.',
      mode_is: 'الطريقة: {mode}',
      rec_start: 'بدء',
      rec_stop: 'انتهيت',
      rec_wait: 'لحظة…',
      rec_time: '{sec} ث',
      listening: 'أنا أستمع إليك…',
      checking: 'أتحقّق الآن…',
      max_reached: 'هذا أطول ما أستطيع الاستماع إليه (دقيقتان).',
      heard_label: 'ما سمعته',
      say_again: 'المحاولة مرة أخرى',
      listen: 'استماع',
      press_listen: 'هيا نضغط «استماع» لنسمعه.',
      too_quiet: 'بالكاد أسمعك. هيا نقترب قليلًا ونتكلّم بصوت أعلى.',
      too_short: 'كان ذلك قصيرًا جدًا. هيا نضغط الزر، ونقرأ النص كله، ثم نضغطه مرة أخرى.',
      score: 'الكلمات الصحيحة: {ok} من {n}',
      legend_match: 'صحيحة',
      legend_sub: 'سُمعت بشكل مختلف',
      legend_sub_written: 'كُتبت بشكل مختلف',
      legend_del: 'متروكة',
      legend_ins: 'كلمة زائدة',
      sr_heard: 'سُمع:',
      sr_written: 'كُتب:',
      sr_skipped: 'متروكة',
      sr_extra: 'كلمة زائدة:',
      verdict_same_meaning: 'المعنى نفسه',
      verdict_nearly: 'المعنى نفسه تقريبًا',
      verdict_partly: 'صحيح جزئيًا',
      verdict_different: 'معنى مختلف',
      verdict_unclear: 'لم أسمع جيدًا',
      missing_ideas: 'أفكار ناقصة',
      wrong_ideas: 'أفكار تحتاج إلى تصحيح',
      approximate: 'تحقّق تقريبي (بلا اتصال)',
      dict_title: 'الإملاء',
      dict_intro: 'هيا نجهّز قلمًا وورقة! سأقول النص ببطء، جزءًا صغيرًا في كل مرة.',
      dict_start: 'بدء الإملاء',
      preparing: 'أستعدّ…',
      phrase_n: 'الجزء {i} من {n}',
      voice_unclear: 'قد لا يكون الصوت واضحًا في هذا الجزء. يُرجى الضغط على «إعادة» لسماعه من جديد، أو إظهار الكلمات.',
      press_repeat: 'هيا نضغط «إعادة» لنسمعه.',
      repeat: 'إعادة',
      next: 'التالي',
      finish: 'انتهيت',
      show_phrase: 'إظهار الكلمات (للكبار)',
      hide_phrase: 'إخفاء الكلمات',
      no_phrases: 'لا يوجد في هذا النص شيء للإملاء.',
      dict_check_title: 'تصحيح الكتابة',
      dict_check_intro: 'يُرجى تصوير ورقة طفلك، أو كتابة ما كُتب عليها كما هو تمامًا، بما في ذلك الأخطاء.',
      written_label: 'ما كُتب على الورقة',
      check_writing: 'التحقّق',
      reading_writing: 'جارٍ قراءة الخط…',
      written_empty: 'يُرجى كتابة ما كُتب على الورقة، أو التقاط صورة لها.',
      needs_manual_writing: 'قراءة الخط تحتاج إلى الذكاء الاصطناعي عبر الإنترنت. يُرجى كتابة ما كُتب على الورقة.',
      parent_review_title: 'يُرجى المراجعة قبل عرض النتيجة على طفلك',
      parent_review_intro: 'قد يخطئ الذكاء الاصطناعي في قراءة الخط. يُرجى تصحيح النص أدناه إن لزم وإعادة التحقّق، ثم التأكيد.',
      illegible: 'كان الخط صعب القراءة. يُرجى مراجعته بعناية.',
      read_text_label: 'ما تمّت قراءته',
      uncertain: 'كلمات غير مؤكَّدة: {words}',
      recheck: 'إعادة التحقّق بهذا النص',
      review_stale: 'تغيّر النص. يُرجى الضغط على «إعادة التحقّق بهذا النص» قبل التأكيد.',
      confirm_result: 'تأكيد النتيجة',
      dict_result_title: 'إملاؤك',
      new_dictation: 'إملاء جديد',
      quran_title: 'القرآن الكريم',
      juz_amma_only: 'جزء عمّ فقط (السور ٧٨–١١٤)',
      surah: 'السورة',
      from_ayah: 'من الآية',
      to_ayah: 'إلى الآية',
      range_capped: 'خمسون آية على الأكثر في كل مرة.',
      quran_mode: 'طريقة التلاوة',
      mode_looking: 'تلاوة مع النظر',
      mode_memory: 'من الحفظ',
      quran_text_hidden: 'النص مخفي. هيا نتلو من الحفظ!',
      hint: 'تلميح: الكلمة التالية',
      hint_none: 'لا توجد كلمات أخرى.',
      quran_rec: 'بدء التلاوة',
      loading: 'جارٍ التحميل…',
      where_am_i: 'أين أنا؟',
      where_stop: 'إيقاف وبحث',
      only_this_surah: 'البحث في هذه السورة فقط',
      locating: 'أبحث عن الموضع…',
      found_at: 'سورة {name} ({s})، الآية {a}',
      not_found: 'لم أجد الموضع. هيا نتلو بضع كلمات أخرى!',
      go_there: 'الانتقال إليها',
      first_error_at: 'هيا نراجع الآية {a}.',
      rehide: 'إخفاء النص والمحاولة مرة أخرى',
      ayah_label: 'الآية {a}',
      error_generic: 'حدث خطأ. يُرجى المحاولة مرة أخرى.',
      error_too_big: 'هذا كبير جدًا عليّ. يُرجى تجربة شيء أقصر أو أصغر.',
      error_unavailable: 'هذا غير متاح الآن.',
      error_quran_text: 'هذا النص من القرآن الكريم. يُرجى التدرّب عليه في قسم القرآن الكريم.',
      error_quran_phrase: 'جزء من هذا النص آية من القرآن الكريم (مثل البسملة)، والتطبيق لا يقرأ القرآن الكريم بصوت مسموع أبدًا، لذلك لا يمكن استخدام هذا النص في الإملاء، ولكن يمكن تسميعه.',
      error_unreadable_text: 'تعذّرت قراءة بعض الكلمات، وهي معلَّمة بـ [?]. يُرجى كتابتها مكان [?] أولًا.',
      error_lang_mismatch: 'هذا النص ليس باللغة المختارة. يُرجى اختيار لغة النص.',
      error_text_too_long: 'هذا النص طويل جدًا. يُرجى استخدام نص أقصر.',
      error_no_words: 'لا توجد في هذا النص كلمات للتحقّق منها.',
      go_quran: 'الانتقال إلى قسم القرآن الكريم',
    },
  };

  const LANGS = ['en', 'fr', 'ar'];
  const AGE_BANDS = ['6-9', '10-13', '14-18'];
  const PROFILE_KEY = 'mommy.profile.v1';
  const SCREENS = ['start', 'prepare', 'recite', 'dictation', 'quran'];
  const MAX_IMAGE_EDGE = 2000;
  const JPEG_QUALITY = 0.85;
  const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
  const MAX_TTS_CHARS = 400;
  const MAX_AYAT = 50;
  const JUZ_AMMA_FIRST = 78;
  const DEFAULT_SURAH = 78;
  const DEFAULT_RANGE = 10;
  const LOCATE_MAX_SECONDS = 30;
  const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

  /**
   * Which conditions each gated feature needs. Controls carry data-gate="<name>"; a
   * <p data-why="<name>"> next to them explains why they are disabled.
   */
  const GATES = {
    'prep-photo': ['server', 'brain', 'consent'],
    'recite-rec': ['server', 'asr', 'consent', 'mic'],
    'recite-tts': ['server', 'tts'],
    'dict-start': ['server'],
    // A typed check is worded by Claude when it is configured: that needs the consent.
    'dict-check': ['server', 'ai-consent'],
    'dict-play': ['server', 'tts'],
    'dict-photo': ['server', 'brain', 'consent'],
    'dict-tts': ['server', 'tts'],
    quran: ['server', 'quran'],
    'quran-rec': ['server', 'quran', 'asr', 'consent', 'mic'],
  };

  // ===========================================================================
  // State
  // ===========================================================================

  const state = {
    started: false, // the start screen was passed in this session
    screen: 'start',
    consent: false, // never stored: asked again at the start of every session
    health: null,
    healthState: 'loading', // loading | ok | down
    profile: defaultProfile(),
    // langChosen: the parent picked the text language (or a photo set it); until then it
    // follows the interface language. confirmToken drops a confirmation overtaken by an edit.
    page: { text: '', lang: 'en', mode: 'strict', confirmed: false, langChosen: false, confirmToken: 0 },
    recording: null, // { control, recorder }
    // Bumped whenever spoken feedback that is still on its way must not play any more (a
    // recording starts, the screen changes, a new result arrives).
    speechToken: 0,
    recite: { lastFeedback: null, feedbackBlob: null },
    dictation: {
      stage: 'intro',
      phrases: [],
      index: 0,
      audio: new Map(), // phrase index -> Promise of {blob, check}: the synthetic voice (not child data)
      result: null,
      feedbackBlob: null,
      token: 0,
      loading: false, // the voice of the current phrase is being fetched
      waiting: false, // the current phrase has not been heard to the end yet
      playId: 0, // the latest phrase playback
      checking: false, // a /api/dictation/check request is running
    },
    quran: {
      surahs: [],
      loaded: null, // { surah, from, to }
      ayat: [],
      words: [], // [{ ayah, index, text, el }] in reading order
      hintStart: 0,
      hintEnd: 0,
      revealed: false,
      loadToken: 0,
    },
  };

  // ===========================================================================
  // Small helpers
  // ===========================================================================

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else node.setAttribute(k, v === true ? '' : String(v));
      }
    }
    if (children) {
      for (const c of [].concat(children)) {
        if (c === null || c === undefined || c === false) continue;
        node.append(c instanceof Node ? c : document.createTextNode(String(c)));
      }
    }
    return node;
  }

  function uiLang() {
    return state.profile.lang;
  }

  /**
   * Translate a key into the UI language, filling {placeholders}. Number values are
   * formatted here, in the current UI language, so they follow a language switch.
   */
  function t(key, vars) {
    const table = STRINGS[uiLang()] || STRINGS.en;
    let s = table[key];
    if (s === undefined) s = STRINGS.en[key];
    if (s === undefined) return key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, (m, name) => {
        const v = vars[name];
        if (v === undefined) return m;
        return typeof v === 'number' ? fmtNum(v) : String(v);
      });
    }
    return s;
  }

  /** A number in the UI language: Arabic-Indic digits in the Arabic UI, like the ayah markers. */
  function fmtNum(n) {
    if (uiLang() === 'ar') return arabicDigits(n);
    try {
      return new Intl.NumberFormat(uiLang()).format(n);
    } catch (e) {
      return String(n);
    }
  }

  function arabicDigits(n) {
    return String(n).replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]);
  }

  /** Arabic-Indic and Persian digits typed by the user, as ASCII digits. */
  function asciiDigits(s) {
    return String(s)
      .replace(/[\u0660-\u0669]/g, (d) => String(d.charCodeAt(0) - 0x0660))
      .replace(/[\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
  }

  function dirOf(lang) {
    return lang === 'ar' ? 'rtl' : 'ltr';
  }

  /** Give a block of text in `lang` the right lang and dir (Arabic is always RTL). */
  function setTextLang(node, lang) {
    node.setAttribute('lang', lang);
    node.setAttribute('dir', dirOf(lang));
  }

  /**
   * Set a translated text that is re-translated automatically when the UI language
   * changes. `detail` is extra untranslated text (notes read from a page) shown after it,
   * isolated so that its direction cannot scramble the sentence around it.
   */
  function setT(node, key, vars, detail) {
    if (!node) return;
    if (!key) {
      delete node.dataset.i18n;
      delete node.dataset.i18nVars;
      delete node.dataset.i18nDetail;
      node.textContent = '';
      return;
    }
    node.dataset.i18n = key;
    if (vars) node.dataset.i18nVars = JSON.stringify(vars);
    else delete node.dataset.i18nVars;
    if (detail) node.dataset.i18nDetail = detail;
    else delete node.dataset.i18nDetail;
    paintT(node, vars);
  }

  /** Write a node's translated text from its data-i18n attributes. */
  function paintT(node, vars) {
    node.textContent = t(node.dataset.i18n, vars);
    const detail = node.dataset.i18nDetail;
    if (detail) node.append(' ', el('bdi', null, '(' + detail + ')'));
  }

  function clearStatus(node) {
    setT(node, null);
    node.classList.remove('is-error');
    setStatusAction(node, null);
  }

  /** opts: {error, detail, action}; action 'quran' adds a button to the Quran section. */
  function setStatus(node, key, vars, opts) {
    const o = opts || {};
    setT(node, key, vars, o.detail);
    node.classList.toggle('is-error', !!o.error);
    setStatusAction(node, o.action || null);
  }

  /** The button shown right after a status line (only 'quran' exists), or none. */
  function setStatusAction(node, action) {
    const next = node.nextElementSibling;
    const current = next && next.classList.contains('status-action') ? next : null;
    if (!action) {
      if (current) current.remove();
      return;
    }
    if (current) return;
    const btn = el('button', { type: 'button', class: 'btn btn-small status-action' });
    setT(btn, 'go_quran');
    btn.addEventListener('click', () => go('quran'));
    node.after(btn);
  }

  function showError(node, err) {
    const info = errorInfo(err);
    setStatus(node, info.key, null, { error: true, action: info.action });
  }

  function onlyText(s) {
    return typeof s === 'string' ? s : s === null || s === undefined ? '' : String(s);
  }

  // ===========================================================================
  // Profile (localStorage only)
  // ===========================================================================

  function defaultProfile() {
    let lang = 'en';
    try {
      const nav = (navigator.language || 'en').slice(0, 2).toLowerCase();
      if (LANGS.includes(nav)) lang = nav;
    } catch (e) {
      /* keep English */
    }
    return { nickname: '', age: '6-9', lang, quran: { surah: DEFAULT_SURAH, from: 1, to: DEFAULT_RANGE, juzAmma: true } };
  }

  function loadProfile() {
    const base = defaultProfile();
    try {
      const raw = window.localStorage.getItem(PROFILE_KEY);
      if (!raw) return base;
      const p = JSON.parse(raw);
      const out = Object.assign({}, base);
      if (typeof p.nickname === 'string') out.nickname = p.nickname.slice(0, 24);
      if (AGE_BANDS.includes(p.age)) out.age = p.age;
      if (LANGS.includes(p.lang)) out.lang = p.lang;
      if (p.quran && typeof p.quran === 'object') {
        out.quran = {
          surah: clampInt(p.quran.surah, 1, 114, base.quran.surah),
          from: clampInt(p.quran.from, 1, 286, 1),
          to: clampInt(p.quran.to, 1, 286, DEFAULT_RANGE),
          juzAmma: p.quran.juzAmma !== false,
        };
      }
      return out;
    } catch (e) {
      return base;
    }
  }

  function saveProfile() {
    try {
      window.localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile));
    } catch (e) {
      /* private mode or storage blocked: the profile lasts for this session only */
    }
  }

  function clampInt(v, lo, hi, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.max(lo, Math.min(hi, n));
  }

  // ===========================================================================
  // Translation of the static page
  // ===========================================================================

  function applyStrings() {
    const lang = uiLang();
    const html = document.documentElement;
    html.setAttribute('lang', lang);
    html.setAttribute('dir', dirOf(lang));
    document.title = t('doc_title');
    for (const node of $$('[data-i18n]')) {
      let vars = null;
      if (node.dataset.i18nVars) {
        try {
          vars = JSON.parse(node.dataset.i18nVars);
        } catch (e) {
          vars = null;
        }
      }
      paintT(node, vars);
    }
    for (const node of $$('[data-i18n-attr]')) {
      for (const pair of node.dataset.i18nAttr.split(',')) {
        const [attr, key] = pair.split(':').map((s) => s.trim());
        if (attr && key) node.setAttribute(attr, t(key));
      }
    }
    renderLegends();
    updateConsentExtra();
    updateHello();
    updateReciteModeLabel();
    updateRecordButtons();
    renderSurahOptions();
    refreshGates();
  }

  // ===========================================================================
  // Server API
  // ===========================================================================

  class ApiError extends Error {
    constructor(status, code, message, scope) {
      super(message || code);
      this.name = 'ApiError';
      this.status = status;
      this.code = code;
      this.serverMessage = message || '';
      // quran_text from api/dictation/phrases: 'phrase' when only a phrase is an ayah
      // (the text may be recited, but not read out for dictation).
      this.scope = scope || null;
    }
  }

  /**
   * Call the Mommy API. `json` sends a JSON body, `form` a multipart FormData.
   * Resolves to parsed JSON (or a Blob with as: 'blob'); rejects with ApiError.
   */
  async function api(path, options) {
    const o = options || {};
    const init = { method: 'GET', headers: {}, cache: 'no-store', credentials: 'same-origin' };
    if (o.json !== undefined) {
      init.method = 'POST';
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(o.json);
    } else if (o.form) {
      init.method = 'POST';
      init.body = o.form;
    }
    let res;
    try {
      res = await fetch(path, init);
    } catch (e) {
      throw new ApiError(0, 'network', '');
    }
    if (!res.ok) {
      let code = 'http_' + res.status;
      let message = '';
      let scope = null;
      try {
        const body = await res.json();
        if (body && typeof body.error === 'string') code = body.error;
        if (body && typeof body.message === 'string') message = body.message;
        if (body && typeof body.scope === 'string') scope = body.scope;
      } catch (e) {
        /* not JSON */
      }
      throw new ApiError(res.status, code, message, scope);
    }
    if (o.as === 'response') return res;
    return o.as === 'blob' ? res.blob() : res.json();
  }

  /** Server error codes with a message of their own. */
  const ERROR_KEYS = {
    quran_text: 'error_quran_text',
    text_too_long: 'error_text_too_long',
    empty_text: 'error_no_words',
    bad_text: 'error_no_words',
    unreadable_text: 'error_unreadable_text',
    lang_mismatch: 'error_lang_mismatch',
  };

  /**
   * {key, action?} for an error: a translated message, plus a button where one helps.
   * The server's own message is English and never shown: it would reach the child.
   */
  function errorInfo(err) {
    if (err && err.name === 'ApiError') {
      if (err.status === 0) return { key: 'server_down' };
      if (err.code === 'quran_text' && err.scope === 'phrase') return { key: 'error_quran_phrase' };
      if (err.code === 'quran_text') return { key: ERROR_KEYS.quran_text, action: 'quran' };
      if (ERROR_KEYS[err.code]) return { key: ERROR_KEYS[err.code] };
      if (err.status === 413) return { key: 'error_too_big' };
      if (err.status === 503 || err.status === 501) return { key: 'error_unavailable' };
      return { key: 'error_generic' };
    }
    if (err && err.name === 'NotAllowedError') return { key: 'mic_denied' };
    if (err && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) return { key: 'mic_missing' };
    if (err && err.name === 'NotSupportedError') return { key: 'no_mic_support' };
    return { key: 'error_generic' };
  }

  async function loadHealth() {
    state.healthState = 'loading';
    refreshGates();
    try {
      const h = await api('api/health');
      state.health = {
        asr: !!h.asr,
        tts: !!h.tts,
        brain: h.brain === 'claude' ? 'claude' : 'offline',
        quran: !!h.quran,
      };
      state.healthState = 'ok';
    } catch (e) {
      state.health = null;
      state.healthState = 'down';
    }
    $('#server-banner').hidden = state.healthState !== 'down';
    updateConsentExtra();
    updateOfflineNotes();
    refreshGates();
    if (state.screen === 'quran') enterQuran();
  }

  // ===========================================================================
  // Feature gates (health, consent, browser support)
  // ===========================================================================

  /** The string key explaining why a gate is closed, or null when it is open. */
  function gateReason(gate) {
    const needs = GATES[gate] || [];
    const h = state.health;
    for (const need of needs) {
      if (need === 'server') {
        if (state.healthState === 'loading') return 'checking_server';
        if (!h) return 'server_down';
      } else if (need === 'asr' && !h.asr) return 'no_asr';
      else if (need === 'tts' && !h.tts) return 'no_tts';
      else if (need === 'brain' && h.brain !== 'claude') return 'no_brain';
      else if (need === 'quran' && !h.quran) return 'no_quran';
      else if (need === 'consent' && !state.consent) return 'consent_needed';
      else if (need === 'ai-consent' && h.brain === 'claude' && !state.consent) return 'consent_needed_ai';
      else if (need === 'mic' && !(window.MommyRecorder && window.MommyRecorder.isSupported())) return 'no_mic_support';
    }
    return null;
  }

  function isOpen(gate) {
    return gateReason(gate) === null;
  }

  /** Apply gates and busy flags to every gated control and explanation. */
  function refreshGates() {
    for (const ctl of $$('[data-gate]')) {
      const reason = gateReason(ctl.dataset.gate);
      const busy = ctl.dataset.busy === '1';
      // A record button that is recording must stay usable, so the child can stop.
      const recordingHere = state.recording && state.recording.control.button === ctl;
      // While one recording runs, the other record buttons wait.
      const otherRecording = state.recording !== null && !recordingHere && (ctl.classList.contains('rec-btn') || ctl.classList.contains('rec-pill'));
      const disabled = !recordingHere && (reason !== null || busy || otherRecording);
      ctl.disabled = disabled;
      const label = ctl.closest('[data-gate-label]');
      if (label) label.classList.toggle('is-disabled', disabled);
      const why = $('[data-why="' + ctl.dataset.gate + '"]');
      if (why) {
        if (!why.id) why.id = 'why-' + ctl.dataset.gate + '-' + Math.random().toString(36).slice(2, 8);
        if (reason) ctl.setAttribute('aria-describedby', why.id);
        else ctl.removeAttribute('aria-describedby');
      }
    }
    // Each reason is explained once per screen (or dictation stage); a server outage
    // once, in the banner.
    const shown = new Map(); // screen or stage element -> Set of reasons already explained
    for (const why of $$('[data-why]')) {
      const reason = gateReason(why.dataset.why);
      const screen = why.closest('.stage, .screen');
      if (!shown.has(screen)) shown.set(screen, new Set());
      const seen = shown.get(screen);
      const show = reason !== null && reason !== 'server_down' && reason !== 'checking_server' && !seen.has(reason);
      if (show) seen.add(reason);
      why.hidden = !show;
      // A hidden duplicate keeps its text: aria-describedby still reads it to screen readers.
      if (reason !== null && reason !== 'server_down' && reason !== 'checking_server') setT(why, reason);
      else setT(why, null);
    }
  }

  function setBusy(node, busy) {
    if (!node) return;
    if (busy) node.dataset.busy = '1';
    else delete node.dataset.busy;
    if (node.dataset.gate) refreshGates();
    else node.disabled = !!busy;
  }

  function updateConsentExtra() {
    const node = $('#consent-extra');
    if (!node) return;
    if (state.health && state.health.brain === 'claude') setT(node, 'consent_claude');
    else if (state.health) setT(node, 'consent_offline');
    else setT(node, null);
    node.hidden = !state.health;
  }

  function updateOfflineNotes() {
    const offline = !!state.health && state.health.brain !== 'claude';
    $('#mode-offline-note').hidden = !offline;
  }

  // ===========================================================================
  // Navigation
  // ===========================================================================

  function go(screen) {
    if (!SCREENS.includes(screen)) screen = 'start';
    if (!state.started) screen = 'start';
    if (location.hash !== '#' + screen) {
      location.hash = screen; // the hashchange handler shows it
    } else {
      showScreen(screen);
    }
  }

  function onHashChange() {
    const wanted = (location.hash || '').replace(/^#/, '');
    let screen = SCREENS.includes(wanted) ? wanted : 'start';
    if (!state.started) screen = 'start';
    showScreen(screen);
  }

  function showScreen(screen) {
    if (state.screen !== screen) leaveScreen(state.screen);
    state.screen = screen;
    for (const section of $$('.screen')) section.hidden = section.dataset.screen !== screen;
    for (const tab of $$('#nav .tab')) {
      if (tab.dataset.go === screen) tab.setAttribute('aria-current', 'page');
      else tab.removeAttribute('aria-current');
    }
    $('#nav').hidden = !state.started;
    $('#btn-profile').hidden = !state.started;
    if (screen === 'recite') enterRecite();
    else if (screen === 'dictation') enterDictation();
    else if (screen === 'quran') enterQuran();
    else if (screen === 'prepare') enterPrepare();
    window.scrollTo(0, 0);
    const heading = $('.screen:not([hidden]) h1');
    if (heading && state.started) {
      heading.setAttribute('tabindex', '-1');
      heading.focus({ preventScroll: true });
    }
  }

  function leaveScreen() {
    state.speechToken++; // feedback still being fetched is not played on another screen
    cancelRecording();
    player.stop();
  }

  // ===========================================================================
  // Start screen
  // ===========================================================================

  function initStart() {
    const form = $('#profile-form');
    $('#nickname').value = state.profile.nickname;
    $('#age').value = state.profile.age;
    $('#ui-lang').value = state.profile.lang;
    $('#consent').checked = state.consent;

    $('#ui-lang').addEventListener('change', (e) => {
      const lang = e.target.value;
      if (!LANGS.includes(lang)) return;
      state.profile.lang = lang;
      // Until the parent picks the language of the text (or types one), it is the one
      // picked here. "Confirm text" also checks the script of the text.
      if (!state.page.langChosen && !state.page.confirmed && !$('#page-text').value.trim()) setPageLang(lang);
      saveProfile();
      applyStrings();
    });
    $('#age').addEventListener('change', (e) => {
      if (AGE_BANDS.includes(e.target.value)) {
        state.profile.age = e.target.value;
        saveProfile();
      }
    });
    $('#nickname').addEventListener('change', (e) => {
      state.profile.nickname = e.target.value.trim().slice(0, 24);
      saveProfile();
      updateHello();
    });
    $('#consent').addEventListener('change', (e) => {
      state.consent = e.target.checked;
      if (!state.consent) cancelRecording();
      refreshGates();
    });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      state.profile.nickname = $('#nickname').value.trim().slice(0, 24);
      saveProfile();
      updateHello();
      state.started = true;
      go(state.page.confirmed ? 'recite' : 'prepare');
    });
  }

  function updateHello() {
    const name = state.profile.nickname;
    for (const id of ['#recite-hello', '#dict-hello']) {
      const node = $(id);
      if (!node) continue;
      if (name) setT(node, 'hello_name', { name });
      else setT(node, 'hello_anon');
    }
  }

  // ===========================================================================
  // Images: resize in the browser and re-encode as JPEG (drops EXIF)
  // ===========================================================================

  /**
   * Turn a picked photo into a JPEG Blob whose long edge is at most 2000 px.
   * Drawing on a canvas bakes in the EXIF orientation and drops all metadata.
   */
  async function shrinkImage(file) {
    if (!file || (file.type && !/^image\//.test(file.type))) throw new Error('not an image');
    let source = null;
    let width = 0;
    let height = 0;
    let release = () => {};
    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
        source = bitmap;
        width = bitmap.width;
        height = bitmap.height;
        release = () => bitmap.close();
      } catch (e) {
        source = null;
      }
    }
    if (!source) {
      const url = URL.createObjectURL(file);
      const img = new Image();
      try {
        img.src = url;
        await img.decode();
      } catch (e) {
        URL.revokeObjectURL(url);
        throw e;
      }
      source = img;
      width = img.naturalWidth;
      height = img.naturalHeight;
      release = () => {
        URL.revokeObjectURL(url);
        img.removeAttribute('src');
      };
    }
    try {
      if (!width || !height) throw new Error('empty image');
      const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(width, height));
      const w = Math.max(1, Math.round(width * scale));
      const h = Math.max(1, Math.round(height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const g = canvas.getContext('2d');
      g.fillStyle = '#ffffff'; // transparent PNG areas become white paper
      g.fillRect(0, 0, w, h);
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = 'high';
      g.drawImage(source, 0, 0, w, h);
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('encode failed'))), 'image/jpeg', JPEG_QUALITY);
      });
      canvas.width = 0;
      canvas.height = 0;
      if (blob.size > MAX_IMAGE_BYTES) throw new ApiError(413, 'too_large', '');
      return blob;
    } finally {
      release();
    }
  }

  /** Read the picked file of a file input, then clear the input so nothing is kept. */
  function takeFile(input) {
    const file = input.files && input.files[0];
    input.value = '';
    return file || null;
  }

  // ===========================================================================
  // Audio playback of synthetic speech (never used for the Quran)
  // ===========================================================================

  const player = {
    audio: null,
    url: null,
    done: null,
    /**
     * Play a WAV Blob; resolves when playback starts (rejects if blocked). `onDone` is
     * called once when this playback ends, fails or is stopped.
     */
    async play(blob, onDone) {
      this.stop();
      this.url = URL.createObjectURL(blob);
      const audio = new Audio(this.url);
      this.audio = audio;
      this.done = onDone || null;
      const finish = () => {
        if (this.audio === audio) this.stop();
      };
      audio.addEventListener('ended', finish);
      audio.addEventListener('error', finish);
      try {
        await audio.play();
      } catch (e) {
        finish();
        throw e;
      }
    },
    stop() {
      const done = this.done;
      this.done = null;
      if (this.audio) {
        this.audio.pause();
        this.audio = null;
      }
      if (this.url) {
        URL.revokeObjectURL(this.url);
        this.url = null;
      }
      if (done) done();
    },
  };

  /**
   * Fetch synthetic speech for `text`: {blob, check}. `check` is the server's
   * X-Speech-Check: 'passed', 'failed' (the voice may not say the phrase clearly) or
   * 'skipped'.
   */
  async function fetchSpeech(text, lang, slow) {
    const res = await api('api/tts', { json: { text, lang, slow: !!slow }, as: 'response' });
    const check = (res.headers.get('X-Speech-Check') || 'skipped').toLowerCase();
    return { blob: await res.blob(), check };
  }

  // ===========================================================================
  // Recording controls
  // ===========================================================================

  /**
   * A record button: press to start, press again to stop. `onBlob(wavBlob, {limit})`
   * receives the recording; `limit` is true when the length limit stopped it. Only one
   * recording runs at a time in the whole app.
   */
  function makeRecordControl(config) {
    const control = {
      button: config.button,
      meter: config.meter,
      timer: config.timer,
      status: config.status,
      startKey: config.startKey,
      maxSeconds: config.maxSeconds || window.MommyRecorder.MAX_SECONDS,
      onBlob: config.onBlob,
      beforeStart: config.beforeStart || null,
    };
    control.button.addEventListener('click', () => toggleRecording(control));
    return control;
  }

  async function toggleRecording(control) {
    if (state.recording && state.recording.control === control) {
      await finishRecording();
      return;
    }
    if (state.recording) return;
    if (!isOpen(control.button.dataset.gate)) return;
    if (control.beforeStart && control.beforeStart() === false) return;
    state.speechToken++; // spoken feedback still on its way must not talk over the child
    player.stop();
    const recorder = new window.MommyRecorder.Recorder({
      maxSeconds: control.maxSeconds,
      onLevel: (level, seconds) => showLevel(control, level, seconds),
      onLimit: () => {
        if (state.recording && state.recording.recorder === recorder) {
          if (control.status) setStatus(control.status, 'max_reached');
          finishRecording({ limit: true });
        }
      },
    });
    state.recording = { control, recorder, starting: true };
    setRecordState(control, 'starting');
    refreshGates();
    try {
      await recorder.start();
    } catch (err) {
      if (state.recording && state.recording.recorder === recorder) state.recording = null;
      setRecordState(control, 'idle');
      refreshGates();
      if (err && err.name === 'AbortError') return;
      if (control.status) showError(control.status, err);
      return;
    }
    if (!state.recording || state.recording.recorder !== recorder) {
      recorder.cancel();
      return;
    }
    state.recording.starting = false;
    setRecordState(control, 'recording');
    if (control.status) setStatus(control.status, 'listening');
    refreshGates();
  }

  async function finishRecording(meta) {
    const info = { limit: !!(meta && meta.limit) };
    const keepStatus = info.limit;
    const rec = state.recording;
    if (!rec || rec.starting) return;
    state.recording = null;
    const { control, recorder } = rec;
    setRecordState(control, 'idle');
    // Busy from now until the server has answered, so a double tap cannot start again.
    setBusy(control.button, true);
    try {
      let blob;
      try {
        blob = await recorder.stop();
      } catch (err) {
        if (control.status) showError(control.status, err);
        return;
      }
      if (control.status && !keepStatus) clearStatus(control.status);
      await control.onBlob(blob, info);
    } finally {
      setBusy(control.button, false);
    }
  }

  /** Drop any recording in progress and release the microphone. */
  function cancelRecording() {
    const rec = state.recording;
    if (!rec) return;
    state.recording = null;
    rec.recorder.cancel();
    setRecordState(rec.control, 'idle');
    if (rec.control.status) clearStatus(rec.control.status);
    refreshGates();
  }

  function showLevel(control, level, seconds) {
    // The last buffered frame can arrive after the button went back to idle.
    if (!state.recording || state.recording.control !== control) return;
    if (control.meter) control.meter.style.setProperty('--level', level.toFixed(3));
    if (control.timer) setT(control.timer, 'rec_time', { sec: Math.floor(seconds) });
  }

  function setRecordState(control, mode) {
    const b = control.button;
    b.dataset.state = mode; // the visible label says what a press will do next
    const label = $('.rec-label', b);
    if (label) {
      const key = mode === 'recording' ? (b.id === 'btn-quran-where' ? 'where_stop' : 'rec_stop') : mode === 'starting' ? 'rec_wait' : control.startKey;
      setT(label, key);
    }
    if (control.meter) {
      control.meter.classList.toggle('is-on', mode === 'recording');
      control.meter.style.setProperty('--level', '0');
    }
    if (control.timer && mode !== 'recording') setT(control.timer, null);
  }

  function updateRecordButtons() {
    for (const control of [reciteControl, quranControl, whereControl]) {
      if (!control) continue;
      const mode = state.recording && state.recording.control === control ? (state.recording.starting ? 'starting' : 'recording') : 'idle';
      setRecordState(control, mode);
    }
  }

  // ===========================================================================
  // Word highlighting (shared by recite, dictation and the Quran)
  // ===========================================================================

  /**
   * Fill `container` with the words of an alignment. Each op is a CheckResult op:
   * {kind: match|sub|del|ins, expected, heard}. `context` is 'heard' (speech) or
   * 'written' (dictation): it only changes the screen-reader wording.
   */
  function renderOps(container, ops, lang, context) {
    container.textContent = '';
    setTextLang(container, lang);
    const ctx = context === 'written' ? 'written' : 'heard';
    let first = true;
    for (const op of ops || []) {
      if (!first) container.append(' ');
      first = false;
      container.append(wordNode(op.kind, onlyText(op.expected), onlyText(op.heard), ctx));
    }
  }

  function srOnly(text) {
    return el('span', { class: 'sr-only', text });
  }

  /** One highlighted word. Each kind has a colour and a shape. */
  function wordNode(kind, expected, heard, ctx) {
    if (kind === 'match') {
      return el('span', { class: 'w w-match' }, expected);
    }
    if (kind === 'sub') {
      return el('span', { class: 'w w-sub' }, [
        el('span', { class: 'w-exp' }, expected),
        srOnly(' (' + t(ctx === 'written' ? 'sr_written' : 'sr_heard') + ' '),
        el('span', { class: 'w-heard' }, heard),
        srOnly(')'),
      ]);
    }
    if (kind === 'del') {
      return el('del', { class: 'w w-del' }, [expected, srOnly(' (' + t('sr_skipped') + ')')]);
    }
    if (kind === 'ins') {
      return el('ins', { class: 'w w-ins' }, [srOnly('(' + t('sr_extra') + ' '), '[' + heard + ']', srOnly(')')]);
    }
    return el('span', { class: 'w' }, expected || heard);
  }

  /** Sample words for the legend, in the script of the text being checked. */
  const LEGEND_SAMPLES = {
    latin: { word: 'abc', other: 'abd' },
    ar: { word: 'كتب', other: 'كتاب' },
  };

  /**
   * Fill every legend list with the four kinds, using the same styles as the words.
   * The samples follow the text language (data-sample-lang, else the page language).
   */
  function renderLegends() {
    for (const list of $$('.legend')) {
      const ctx = list.dataset.legend === 'written' ? 'written' : 'heard';
      const sampleLang = list.dataset.sampleLang || state.page.lang;
      const s = sampleLang === 'ar' ? LEGEND_SAMPLES.ar : LEGEND_SAMPLES.latin;
      list.textContent = '';
      const items = [
        ['match', 'legend_match', el('span', { class: 'w w-match' }, s.word)],
        ['sub', ctx === 'written' ? 'legend_sub_written' : 'legend_sub', el('span', { class: 'w w-sub' }, [el('span', { class: 'w-exp' }, s.word), el('span', { class: 'w-heard' }, s.other)])],
        ['del', 'legend_del', el('del', { class: 'w w-del' }, s.word)],
        ['ins', 'legend_ins', el('ins', { class: 'w w-ins' }, '[' + s.word + ']')],
      ];
      for (const [kind, key, sample] of items) {
        sample.setAttribute('aria-hidden', 'true');
        setTextLang(sample, sampleLang);
        list.append(el('li', { class: 'legend-item legend-' + kind }, [sample, ' ', el('span', { class: 'legend-text' }, t(key))]));
      }
    }
  }

  // ===========================================================================
  // Prepare a page (parent)
  // ===========================================================================

  function initPrepare() {
    const textarea = $('#page-text');
    const langSelect = $('#page-lang');
    langSelect.value = state.page.lang;
    setTextLang(textarea, state.page.lang);

    langSelect.addEventListener('change', () => {
      if (!LANGS.includes(langSelect.value)) return;
      state.page.langChosen = true;
      setPageLang(langSelect.value);
      markUnconfirmed();
    });
    textarea.addEventListener('input', markUnconfirmed);
    for (const radio of $$('input[name="mode"]')) {
      radio.addEventListener('change', () => {
        if (radio.checked) {
          state.page.mode = radio.value === 'contextual' ? 'contextual' : 'strict';
          updateReciteModeLabel();
          resetRecite(); // a result of the other mode must not stay under the new label
        }
      });
    }
    for (const id of ['#prep-take', '#prep-choose']) {
      $(id).addEventListener('change', (e) => readPagePhoto(e.target));
    }
    $('#btn-confirm').addEventListener('click', confirmText);
  }

  function enterPrepare() {
    $('#page-lang').value = state.page.lang;
  }

  /** Set the language of the page text (the select, and the textarea's lang and dir). */
  function setPageLang(lang) {
    state.page.lang = lang;
    $('#page-lang').value = lang;
    setTextLang($('#page-text'), lang);
  }

  function markUnconfirmed() {
    const status = $('#prep-confirm-status');
    // A confirmation still waiting for the server is for the old text: drop it.
    state.page.confirmToken++;
    setBusy($('#btn-confirm'), false);
    if (!state.page.confirmed) {
      if (status.dataset.i18n === 'checking_text') clearStatus(status);
      return;
    }
    state.page.confirmed = false;
    setStatus(status, 'text_changed');
    $('#prep-next').hidden = true;
  }

  /** 'arabic' or 'latin': the script most letters of `text` are written in, or null. */
  function mainScript(text) {
    const arabic = (text.match(/\p{Script=Arabic}/gu) || []).length;
    const latin = (text.match(/\p{Script=Latin}/gu) || []).length;
    if (arabic > latin) return 'arabic';
    if (latin > arabic) return 'latin';
    return null;
  }

  async function readPagePhoto(input) {
    const file = takeFile(input);
    if (!file || !isOpen('prep-photo')) return;
    const status = $('#prep-status');
    let jpeg;
    try {
      jpeg = await shrinkImage(file);
    } catch (err) {
      if (err && err.name === 'ApiError') showError(status, err);
      else setStatus(status, 'photo_bad', null, { error: true });
      return;
    }
    const form = new FormData();
    form.append('image', jpeg, 'page.jpg');
    form.append('lang', state.page.lang);
    jpeg = null;
    setStatus(status, 'reading_page');
    const quranNote = $('#prep-quran-note');
    clearStatus(quranNote);
    for (const n of $$('[data-gate="prep-photo"]')) setBusy(n, true);
    try {
      const res = await api('api/page/read', { form });
      const text = onlyText(res.text);
      if (LANGS.includes(res.lang)) {
        state.page.langChosen = true;
        setPageLang(res.lang);
      }
      $('#page-text').value = text;
      markUnconfirmed();
      if (res.needs_manual || !text.trim()) setStatus(status, 'page_needs_manual');
      else if (res.notes) setStatus(status, 'page_read_ok', null, { detail: onlyText(res.notes) });
      else setStatus(status, 'page_read_ok');
      // The Quran is practised in its own section, against the verbatim text.
      if (res.contains_quran === true) setStatus(quranNote, 'page_has_quran', null, { action: 'quran' });
      $('#page-text').focus();
    } catch (err) {
      if (err && err.code === 'needs_manual') setStatus(status, 'page_needs_manual');
      else showError(status, err);
    } finally {
      for (const n of $$('[data-gate="prep-photo"]')) setBusy(n, false);
    }
  }

  /**
   * Confirm the page text. The script of the text must fit its language, and the server
   * must accept the text (it refuses Quran text and texts that are too long), so that
   * the parent hears about a problem here and not the child after reciting.
   */
  async function confirmText() {
    const text = $('#page-text').value.trim();
    const status = $('#prep-confirm-status');
    const btn = $('#btn-confirm');
    if (!text) {
      setStatus(status, 'text_empty', null, { error: true });
      $('#page-text').focus();
      return;
    }
    // Only Arabic, of the three languages, is written in Arabic script.
    const script = mainScript(text);
    let switched = false;
    if (script === 'arabic' && $('#page-lang').value !== 'ar') {
      setPageLang('ar');
      state.page.langChosen = true;
      switched = true;
    } else if (script === 'latin' && $('#page-lang').value === 'ar') {
      refuseText(status, { key: 'text_not_arabic' });
      $('#page-lang').focus();
      return;
    }
    const lang = $('#page-lang').value;
    const token = ++state.page.confirmToken;
    let noDictation = false;
    setStatus(status, 'checking_text');
    setBusy(btn, true);
    try {
      const res = await api('api/dictation/phrases', { json: { text, lang } });
      if (token !== state.page.confirmToken) return;
      const phrases = Array.isArray(res.phrases) ? res.phrases.filter((p) => typeof p === 'string' && p.trim()) : null;
      if (phrases && !phrases.length) {
        refuseText(status, { key: 'error_no_words' });
        return;
      }
    } catch (err) {
      if (token !== state.page.confirmToken) return;
      // A refused text is not confirmed. If the server cannot be reached, the text is
      // confirmed anyway: each activity reports the problem when it needs the server.
      // A phrase that is a whole ayah (often the basmala on its own line) only rules out
      // dictation, which would read it aloud: the text can still be recited.
      if (err && err.name === 'ApiError' && err.code === 'quran_text' && err.scope === 'phrase') {
        noDictation = true;
      } else if (err && err.name === 'ApiError' && err.status >= 400 && err.status < 500) {
        refuseText(status, errorInfo(err));
        return;
      }
    } finally {
      if (token === state.page.confirmToken) setBusy(btn, false);
    }
    state.page.text = text;
    state.page.lang = lang;
    const mode = $('input[name="mode"]:checked');
    state.page.mode = mode && mode.value === 'contextual' ? 'contextual' : 'strict';
    state.page.confirmed = true;
    resetRecite();
    resetDictation();
    renderLegends();
    clearStatus($('#prep-quran-note')); // it was about the page as read, before any edits
    setStatus(status, noDictation ? 'text_confirmed_no_dictation' : switched ? 'text_confirmed_ar' : 'text_confirmed');
    $('#prep-next').hidden = false;
    // A child screen opened meanwhile shows the new text.
    if (state.screen === 'recite') enterRecite();
    else if (state.screen === 'dictation') enterDictation();
  }

  /** The text in the textarea cannot be used: say why ({key, action}) and unconfirm it. */
  function refuseText(status, info) {
    state.page.confirmed = false;
    $('#prep-next').hidden = true;
    setStatus(status, info.key, null, { error: true, action: info.action });
  }

  // ===========================================================================
  // Recite (child)
  // ===========================================================================

  let reciteControl = null;

  function initRecite() {
    reciteControl = makeRecordControl({
      button: $('#recite-rec'),
      meter: $('#recite-meter'),
      timer: $('#recite-timer'),
      status: $('#recite-status'),
      startKey: 'rec_start',
      onBlob: checkRecitation,
      beforeStart: () => {
        $('#recite-result').hidden = true;
        showPlainPage();
        return true;
      },
    });
    $('#recite-say-again').addEventListener('click', () => toggleRecording(reciteControl));
    $('#recite-listen').addEventListener('click', () => playFeedback('recite'));
  }

  function enterRecite() {
    const ready = state.page.confirmed;
    $('#recite-empty').hidden = ready;
    $('#recite-main').hidden = !ready;
    updateReciteModeLabel();
    if (ready && !$('#recite-text').childNodes.length) showPlainPage();
  }

  function updateReciteModeLabel() {
    const node = $('#recite-mode-label');
    if (!node) return;
    const modeKey = state.page.mode === 'contextual' ? 'mode_contextual' : 'mode_strict';
    setT(node, 'mode_is', { mode: t(modeKey) });
  }

  function showPlainPage() {
    const box = $('#recite-text');
    box.textContent = state.page.text;
    box.classList.add('plain');
    setTextLang(box, state.page.lang);
    $('#recite-legend').hidden = true;
  }

  function resetRecite() {
    state.speechToken++;
    $('#recite-text').textContent = '';
    $('#recite-result').hidden = true;
    clearStatus($('#recite-status'));
    state.recite.lastFeedback = null;
    state.recite.feedbackBlob = null;
  }

  async function checkRecitation(blob, info) {
    const status = $('#recite-status');
    const form = new FormData();
    form.append('audio', blob, 'recitation.wav');
    form.append('expected_text', state.page.text);
    form.append('lang', state.page.lang);
    form.append('mode', state.page.mode);
    form.append('age', state.profile.age);
    setStatus(status, 'checking');
    let res;
    try {
      res = await api('api/recite/check', { form });
    } catch (err) {
      showError(status, err);
      return;
    }
    clearStatus(status);
    showReciteResult(res, info);
  }

  /** Non-empty strings of a list of ideas from the judgement. */
  function ideaList(ideas) {
    return Array.isArray(ideas) ? ideas.filter((x) => typeof x === 'string' && x.trim()) : [];
  }

  function showReciteResult(res, info) {
    state.speechToken++; // the voice of an older result is not wanted any more
    const lang = state.page.lang;
    const box = $('#recite-result');
    const quality = res.quality || {};
    const contextual = res.mode === 'contextual';
    const result = res.result || {};
    const judgement = res.judgement || {};
    const sayAgain = !!(res.say_again || result.say_again || judgement.say_again || judgement.verdict === 'unclear' || result.verdict === 'unclear' || quality.too_quiet || quality.too_short);

    // Words
    const verdictNode = $('#recite-verdict');
    const scoreNode = $('#recite-score');
    verdictNode.hidden = true;
    scoreNode.hidden = true;
    $('#recite-ideas').hidden = true;
    if (!contextual && Array.isArray(result.ops) && result.ops.length && !sayAgain) {
      const words = $('#recite-text');
      words.classList.remove('plain');
      renderOps(words, result.ops, lang, 'heard');
      $('#recite-legend').hidden = false;
      const ok = result.ops.filter((op) => op.kind === 'match').length;
      setT(scoreNode, 'score', { ok, n: Number(result.n_expected) || 0 });
      scoreNode.hidden = false;
    } else {
      showPlainPage();
    }

    if (contextual && !sayAgain) {
      let v = ['same_meaning', 'partly', 'different'].includes(judgement.verdict) ? judgement.verdict : null;
      const missing = ideaList(judgement.missing_ideas);
      // "Same meaning" with ideas still missing is not the whole meaning.
      if (v === 'same_meaning' && missing.length) v = 'nearly';
      if (v) {
        setT(verdictNode, 'verdict_' + v);
        verdictNode.className = 'verdict verdict-' + v;
        verdictNode.hidden = false;
      }
      fillIdeas('#recite-missing', '#recite-missing-wrap', missing, lang);
      fillIdeas('#recite-wrong', '#recite-wrong-wrap', judgement.wrong_ideas, lang);
      $('#recite-approx').hidden = !judgement.approximate;
      $('#recite-ideas').hidden = !(v || judgement.approximate);
    }

    // Feedback
    const feedback = onlyText(res.feedback);
    const fbNode = $('#recite-feedback');
    fbNode.textContent = feedback;
    setTextLang(fbNode, lang);
    const qNode = $('#recite-quality');
    // A clip that is too short is always "too quiet" too (nobody had started speaking),
    // so the real problem, a stop pressed too early, is named first.
    if (quality.too_short) setT(qNode, 'too_short');
    else if (quality.too_quiet) setT(qNode, 'too_quiet');
    else setT(qNode, null);
    qNode.hidden = !(quality.too_quiet || quality.too_short);
    $('#recite-limit').hidden = !(info && info.limit);

    $('#recite-say-again').hidden = !sayAgain;
    const heard = onlyText(res.heard_text);
    $('#recite-heard-box').hidden = !heard;
    const heardNode = $('#recite-heard');
    heardNode.textContent = heard;
    setTextLang(heardNode, lang);

    state.recite.lastFeedback = feedback ? { text: feedback, lang } : null;
    state.recite.feedbackBlob = null;
    $('#recite-listen').hidden = !feedback;
    box.hidden = false;
    box.focus({ preventScroll: true });
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    if (feedback) playFeedback('recite', true);
  }

  function fillIdeas(listSel, wrapSel, ideas, lang) {
    const list = $(listSel);
    list.textContent = '';
    const items = ideaList(ideas);
    for (const idea of items) {
      const li = el('li', null, idea);
      setTextLang(li, lang);
      list.append(li);
    }
    $(wrapSel).hidden = items.length === 0;
  }

  /**
   * Speak the last feedback of a screen ('recite' or 'dictation') with the synthetic
   * voice. `auto` is true for the automatic play right after a result: if the browser
   * blocks it, a hint to press Listen is shown instead.
   */
  async function playFeedback(which, auto) {
    const holder = which === 'recite' ? state.recite : state.dictation;
    const fb = which === 'recite' ? state.recite.lastFeedback : state.dictation.result && state.dictation.result.feedback;
    const gate = which === 'recite' ? 'recite-tts' : 'dict-tts';
    const status = which === 'recite' ? $('#recite-status') : $('#dict-child-status');
    if (!fb || !fb.text || !isOpen(gate) || fb.text.length > MAX_TTS_CHARS) return;
    // The voice can take a second to arrive. By then the child may be recording again or
    // be on another screen, or a newer result may be shown: then it is not played.
    const token = state.speechToken;
    const screen = state.screen;
    const stale = () => token !== state.speechToken || screen !== state.screen || state.recording !== null;
    try {
      if (!holder.feedbackBlob) {
        const speech = await fetchSpeech(fb.text, fb.lang, false);
        if (stale()) return;
        holder.feedbackBlob = speech.blob;
      }
      if (stale()) return;
      await player.play(holder.feedbackBlob);
    } catch (err) {
      if (stale()) return;
      if (err && err.name === 'NotAllowedError') {
        if (auto) setStatus(status, 'press_listen');
      } else if (!auto) {
        showError(status, err);
      }
    }
  }

  // ===========================================================================
  // Dictation
  // ===========================================================================

  function initDictation() {
    $('#btn-dict-start').addEventListener('click', startDictation);
    $('#dict-repeat').addEventListener('click', () => playPhrase(state.dictation.index, { repeat: true }));
    $('#dict-next').addEventListener('click', nextPhrase);
    $('#dict-show').addEventListener('click', togglePhrase);
    for (const id of ['#dict-take', '#dict-choose']) {
      $(id).addEventListener('change', (e) => checkDictationPhoto(e.target));
    }
    $('#btn-dict-check').addEventListener('click', () => {
      if (!isOpen('dict-check')) return;
      const text = $('#dict-written').value.trim();
      if (!text) {
        setStatus($('#dict-check-status'), 'written_empty', null, { error: true });
        $('#dict-written').focus();
        return;
      }
      checkDictation({ written: text }, $('#dict-check-status'));
    });
    $('#btn-dict-recheck').addEventListener('click', () => {
      if (!isOpen('dict-check')) return;
      const text = $('#dict-read-text').value.trim();
      if (!text) {
        setStatus($('#dict-review-status'), 'written_empty', null, { error: true });
        return;
      }
      checkDictation({ written: text }, $('#dict-review-status'));
    });
    // The marks shown to the parent belong to the text that was checked: once it is
    // edited, it must be checked again before the child sees anything.
    $('#dict-read-text').addEventListener('input', updateReviewConfirm);
    $('#btn-dict-confirm').addEventListener('click', showDictationToChild);
    $('#dict-listen').addEventListener('click', () => playFeedback('dictation'));
    $('#btn-dict-new').addEventListener('click', () => {
      resetDictation();
      setDictStage('intro');
    });
  }

  function enterDictation() {
    const ready = state.page.confirmed;
    $('#dict-empty').hidden = ready;
    $('#dict-main').hidden = !ready;
    setDictStage(state.dictation.stage);
  }

  function setDictStage(stage) {
    state.dictation.stage = stage;
    for (const node of $$('#dict-main .stage')) node.hidden = node.dataset.stage !== stage;
  }

  function resetDictation() {
    const d = state.dictation;
    d.token++;
    state.speechToken++;
    d.phrases = [];
    d.index = 0;
    d.audio.clear();
    d.result = null;
    d.feedbackBlob = null;
    d.stage = 'intro';
    player.stop();
    setPhraseLoading(false);
    setNextWaiting(false);
    $('#dict-unclear').hidden = true;
    $('#dict-written').value = '';
    $('#dict-read-text').value = '';
    for (const id of ['#dict-intro-status', '#dict-speak-status', '#dict-check-status', '#dict-review-status', '#dict-child-status']) clearStatus($(id));
    updateReviewConfirm();
    setDictStage('intro');
  }

  async function startDictation() {
    const status = $('#dict-intro-status');
    const btn = $('#btn-dict-start');
    setStatus(status, 'preparing');
    setBusy(btn, true);
    let res;
    try {
      res = await api('api/dictation/phrases', { json: { text: state.page.text, lang: state.page.lang } });
    } catch (err) {
      showError(status, err);
      return;
    } finally {
      setBusy(btn, false);
    }
    const phrases = Array.isArray(res.phrases) ? res.phrases.filter((p) => typeof p === 'string' && p.trim()) : [];
    if (!phrases.length) {
      setStatus(status, 'no_phrases', null, { error: true });
      return;
    }
    clearStatus(status);
    const d = state.dictation;
    d.token++;
    d.phrases = phrases;
    d.audio.clear();
    d.index = 0;
    for (const id of ['#dict-written', '#dict-read-text']) setTextLang($(id), state.page.lang);
    setDictStage('speak');
    showPhrase();
    playPhrase(0);
  }

  function showPhrase() {
    const d = state.dictation;
    setT($('#dict-counter'), 'phrase_n', { i: d.index + 1, n: d.phrases.length });
    const last = d.index >= d.phrases.length - 1;
    setT($('#dict-next-label'), last ? 'finish' : 'next');
    const phrase = $('#dict-phrase');
    phrase.textContent = d.phrases[d.index] || '';
    setTextLang(phrase, state.page.lang);
    clearStatus($('#dict-speak-status'));
    $('#dict-unclear').hidden = true;
  }

  function togglePhrase() {
    const phrase = $('#dict-phrase');
    const btn = $('#dict-show');
    phrase.hidden = !phrase.hidden;
    btn.setAttribute('aria-expanded', phrase.hidden ? 'false' : 'true');
    setT($('span', btn), phrase.hidden ? 'show_phrase' : 'hide_phrase');
  }

  /** Repeat and Next wait while the voice of the current phrase is fetched. */
  function setPhraseLoading(on) {
    const d = state.dictation;
    d.loading = on;
    setBusy($('#dict-repeat'), on);
    setBusy($('#dict-next'), on || d.waiting);
  }

  /** Next also waits until the phrase has been heard once. */
  function setNextWaiting(on) {
    const d = state.dictation;
    d.waiting = on;
    setBusy($('#dict-next'), on || d.loading);
  }

  /**
   * The voice of phrase `index`, {blob, check}: fetched once and kept for Repeat;
   * `fresh` asks for a new take. A failed fetch is not kept, so the next try asks again.
   */
  function speechFor(index, fresh) {
    const d = state.dictation;
    if (!fresh && d.audio.has(index)) return d.audio.get(index);
    const token = d.token;
    const p = fetchSpeech(d.phrases[index], state.page.lang, true);
    d.audio.set(index, p);
    p.catch(() => {
      if (token === d.token && d.audio.get(index) === p) d.audio.delete(index);
    });
    return p;
  }

  /**
   * Speak phrase `index`. Next stays busy until the phrase has been heard once, so a
   * second press cannot skip a phrase the child never heard. With `repeat`, a take that
   * failed the server's speech check is replaced by a new take, which may be clearer.
   */
  async function playPhrase(index, opts) {
    const d = state.dictation;
    if (!d.phrases[index] || !isOpen('dict-play')) return;
    const token = d.token;
    const playId = ++d.playId;
    const current = () => token === d.token && playId === d.playId;
    const status = $('#dict-speak-status');
    setPhraseLoading(true);
    setNextWaiting(true);
    setStatus(status, 'preparing');
    let speech;
    try {
      speech = await speechFor(index);
      if (current() && opts && opts.repeat && speech.check === 'failed') speech = await speechFor(index, true);
    } catch (err) {
      if (!current()) return;
      setPhraseLoading(false);
      setNextWaiting(false);
      showError(status, err);
      return;
    }
    if (!current()) return;
    setPhraseLoading(false);
    clearStatus(status);
    if (state.screen !== 'dictation') {
      setNextWaiting(false);
      return;
    }
    // For the grown-up: the voice check failed, so the phrase may be hard to understand.
    $('#dict-unclear').hidden = speech.check !== 'failed';
    try {
      await player.play(speech.blob, () => {
        if (current()) setNextWaiting(false);
      });
    } catch (err) {
      if (!current()) return;
      if (err && err.name === 'NotAllowedError') setStatus(status, 'press_repeat');
      else showError(status, err);
      return;
    }
    // While the child listens and writes, the next phrase is fetched.
    if (token === d.token && index + 1 < d.phrases.length) speechFor(index + 1).catch(() => {});
  }

  function nextPhrase() {
    const d = state.dictation;
    if (d.loading || d.waiting) return;
    player.stop();
    if (d.index >= d.phrases.length - 1) {
      d.audio.clear();
      setDictStage('check');
      $('#dict-written').focus();
      return;
    }
    d.index++;
    showPhrase();
    playPhrase(d.index);
  }

  async function checkDictationPhoto(input) {
    const file = takeFile(input);
    if (!file || !isOpen('dict-photo')) return;
    const status = $('#dict-check-status');
    let jpeg;
    try {
      jpeg = await shrinkImage(file);
    } catch (err) {
      if (err && err.name === 'ApiError') showError(status, err);
      else setStatus(status, 'photo_bad', null, { error: true });
      return;
    }
    await checkDictation({ image: jpeg }, status);
  }

  /** Send the child's writing (a photo or typed text) to /api/dictation/check. */
  async function checkDictation(input, status) {
    const form = new FormData();
    form.append('expected_text', state.page.text);
    form.append('lang', state.page.lang);
    form.append('age', state.profile.age);
    if (input.image) form.append('image', input.image, 'writing.jpg');
    else form.append('written_text', input.written);
    setStatus(status, input.image ? 'reading_writing' : 'checking');
    const d = state.dictation;
    const buttons = [$('#btn-dict-check'), $('#btn-dict-recheck'), ...$$('[data-gate="dict-photo"]')];
    for (const b of buttons) setBusy(b, true);
    d.checking = true;
    updateReviewConfirm();
    let res;
    try {
      res = await api('api/dictation/check', { form });
    } catch (err) {
      if (err && err.code === 'needs_manual') {
        setStatus(status, 'needs_manual_writing', null, { error: true });
        $('#dict-written').focus();
      } else {
        showError(status, err);
      }
      return;
    } finally {
      for (const b of buttons) setBusy(b, false);
      d.checking = false;
      updateReviewConfirm();
    }
    clearStatus(status);
    showDictationReview(res);
  }

  /** True when "What was read" was edited after the result shown was computed. */
  function reviewIsStale() {
    const r = state.dictation.result;
    return !!r && $('#dict-read-text').value.trim() !== onlyText(r.res.read_text).trim();
  }

  /** "Confirm result" only shows the child marks that match the text in the box. */
  function updateReviewConfirm() {
    const stale = reviewIsStale();
    $('#dict-stale').hidden = !stale;
    $('#btn-dict-confirm').disabled = stale || state.dictation.checking;
  }

  /** The parent sees the result first and can correct what was read. */
  function showDictationReview(res) {
    state.speechToken++;
    const lang = state.page.lang;
    const result = res.result || {};
    const feedback = onlyText(res.feedback);
    state.dictation.result = { res, feedback: feedback ? { text: feedback, lang } : null };
    state.dictation.feedbackBlob = null;

    const readText = $('#dict-read-text');
    readText.value = onlyText(res.read_text);
    setTextLang(readText, lang);
    updateReviewConfirm();
    const uncertain = Array.isArray(res.uncertain_words) ? res.uncertain_words.filter((w) => typeof w === 'string' && w) : [];
    const unc = $('#dict-uncertain');
    if (uncertain.length) setT(unc, 'uncertain', { words: uncertain.join(uiLang() === 'ar' ? '، ' : ', ') });
    else setT(unc, null);
    unc.hidden = uncertain.length === 0;
    $('#dict-legible').hidden = res.legible !== false;

    renderOps($('#dict-review-words'), result.ops || [], lang, 'written');
    const fb = $('#dict-review-feedback');
    fb.textContent = feedback;
    setTextLang(fb, lang);
    setDictStage('review');
    $('#dict-main [data-stage="review"]').focus({ preventScroll: true });
  }

  function showDictationToChild() {
    const d = state.dictation;
    if (!d.result || d.checking || reviewIsStale()) return;
    const lang = state.page.lang;
    renderOps($('#dict-child-words'), (d.result.res.result || {}).ops || [], lang, 'written');
    const fb = $('#dict-child-feedback');
    fb.textContent = d.result.feedback ? d.result.feedback.text : '';
    setTextLang(fb, lang);
    $('#dict-listen').hidden = !d.result.feedback;
    setDictStage('child');
    $('#dict-main [data-stage="child"]').focus({ preventScroll: true });
    playFeedback('dictation', true);
  }

  // ===========================================================================
  // Quran (verbatim Tanzil text, strict check, template feedback, no TTS)
  // ===========================================================================

  let quranControl = null;
  let whereControl = null;

  function initQuran() {
    quranControl = makeRecordControl({
      button: $('#quran-rec'),
      meter: $('#quran-meter'),
      timer: $('#quran-timer'),
      status: $('#quran-status'),
      startKey: 'quran_rec',
      onBlob: checkQuran,
      beforeStart: () => {
        if (!state.quran.loaded) return false;
        $('#quran-result').hidden = true;
        clearQuranMarks();
        return true;
      },
    });
    whereControl = makeRecordControl({
      button: $('#btn-quran-where'),
      meter: $('#quran-meter'),
      timer: $('#quran-timer'),
      status: $('#quran-where-status'),
      startKey: 'where_am_i',
      maxSeconds: LOCATE_MAX_SECONDS,
      onBlob: locateQuran,
      beforeStart: () => {
        $('#quran-where-list').hidden = true;
        return true;
      },
    });
    $('#quran-say-again').addEventListener('click', () => toggleRecording(quranControl));
    $('#btn-quran-hint').addEventListener('click', revealHint);
    $('#btn-quran-rehide').addEventListener('click', () => {
      clearQuranMarks();
      $('#quran-result').hidden = true;
      state.quran.revealed = false;
      state.quran.hintStart = 0;
      state.quran.hintEnd = 0;
      applyQuranMode();
    });
    $('#quran-juz').addEventListener('change', (e) => {
      state.profile.quran.juzAmma = e.target.checked;
      saveProfile();
      renderSurahOptions(); // may move the chosen surah into Juz' Amma
      const loaded = state.quran.loaded;
      if (loaded && loaded.surah !== state.profile.quran.surah) onSurahChange();
    });
    $('#quran-surah').addEventListener('change', onSurahChange);
    for (const id of ['#quran-from', '#quran-to']) {
      $(id).addEventListener('change', onRangeChange);
    }
    for (const radio of $$('input[name="qmode"]')) {
      radio.addEventListener('change', () => {
        state.quran.revealed = false;
        state.quran.hintStart = 0;
        state.quran.hintEnd = 0;
        clearQuranMarks();
        $('#quran-result').hidden = true;
        applyQuranMode();
      });
    }
  }

  async function enterQuran() {
    if (!isOpen('quran')) return;
    const q = state.quran;
    if (!q.surahs.length) {
      const status = $('#quran-load-status');
      setStatus(status, 'loading');
      try {
        const res = await api('api/quran/surahs');
        q.surahs = Array.isArray(res.surahs) ? res.surahs.filter((s) => s && Number.isInteger(s.number)) : [];
        if (typeof res.attribution === 'string' && res.attribution) $('#quran-attribution').textContent = res.attribution;
        clearStatus(status);
      } catch (err) {
        showError(status, err);
        return;
      }
      renderSurahOptions();
    }
    if (!q.loaded) loadAyat();
  }

  function surahInfo(n) {
    return state.quran.surahs.find((s) => s.number === n) || null;
  }

  function surahLabel(s) {
    const num = uiLang() === 'ar' ? arabicDigits(s.number) : String(s.number);
    if (uiLang() !== 'ar' && s.name_translit) return num + '. ' + s.name_translit + ' — ' + s.name_ar;
    return num + '. ' + s.name_ar;
  }

  function renderSurahOptions() {
    const select = $('#quran-surah');
    if (!select) return;
    const q = state.quran;
    const prefs = state.profile.quran;
    $('#quran-juz').checked = prefs.juzAmma;
    if (!q.surahs.length) return;
    const list = prefs.juzAmma ? q.surahs.filter((s) => s.number >= JUZ_AMMA_FIRST) : q.surahs;
    select.textContent = '';
    for (const s of list) {
      select.append(el('option', { value: s.number }, surahLabel(s)));
    }
    if (!list.some((s) => s.number === prefs.surah)) {
      prefs.surah = list.length ? list[0].number : DEFAULT_SURAH;
    }
    select.value = String(prefs.surah);
    showRange(prefs.from, prefs.to);
  }

  /**
   * The ayah range fields are text fields, so that they can show Arabic-Indic digits in
   * the Arabic UI; both digit systems are accepted when typed.
   */
  function showRange(from, to) {
    $('#quran-from').value = fmtNum(from);
    $('#quran-to').value = fmtNum(to);
  }

  function rangeField(sel) {
    return asciiDigits($(sel).value).replace(/[^0-9]/g, '');
  }

  function onSurahChange() {
    const prefs = state.profile.quran;
    const n = Number($('#quran-surah').value);
    const info = surahInfo(n);
    if (!info) return;
    prefs.surah = n;
    prefs.from = 1;
    prefs.to = Math.min(info.ayah_count, DEFAULT_RANGE);
    showRange(prefs.from, prefs.to);
    saveProfile();
    loadAyat();
  }

  function onRangeChange() {
    const prefs = state.profile.quran;
    const info = surahInfo(prefs.surah);
    if (!info) return;
    const count = info.ayah_count;
    const fromText = rangeField('#quran-from');
    const toText = rangeField('#quran-to');
    let from = fromText ? clampInt(fromText, 1, count, 1) : prefs.from;
    let to = toText ? clampInt(toText, 1, count, from) : prefs.to;
    if (to < from) to = from;
    const capped = to - from + 1 > MAX_AYAT;
    if (capped) to = from + MAX_AYAT - 1;
    $('#quran-range-note').hidden = !capped;
    prefs.from = from;
    prefs.to = to;
    showRange(from, to);
    saveProfile();
    loadAyat();
  }

  async function loadAyat() {
    const q = state.quran;
    const prefs = state.profile.quran;
    const info = surahInfo(prefs.surah);
    if (!info) return;
    const count = info.ayah_count;
    const from = clampInt(prefs.from, 1, count, 1);
    let to = clampInt(prefs.to, from, count, from);
    if (to - from + 1 > MAX_AYAT) to = from + MAX_AYAT - 1;
    const token = ++q.loadToken;
    const status = $('#quran-load-status');
    setStatus(status, 'loading');
    cancelRecording();
    let res;
    try {
      res = await api('api/quran/ayat?surah=' + encodeURIComponent(info.number) + '&from=' + from + '&to=' + to);
    } catch (err) {
      if (token === q.loadToken) showError(status, err);
      return;
    }
    if (token !== q.loadToken) return;
    clearStatus(status);
    if (typeof res.attribution === 'string' && res.attribution) $('#quran-attribution').textContent = res.attribution;
    q.ayat = Array.isArray(res.ayat) ? res.ayat : [];
    q.loaded = { surah: info.number, from, to };
    q.revealed = false;
    q.hintStart = 0;
    q.hintEnd = 0;
    $('#quran-result').hidden = true;
    $('#quran-where-list').hidden = true;
    renderQuranText();
    applyQuranMode();
  }

  function isPauseMark(token) {
    for (const ch of token) {
      const c = ch.codePointAt(0);
      if (c < 0x06d6 || c > 0x06ed) return false;
    }
    return token.length > 0;
  }

  /**
   * Render the loaded ayat verbatim. Each ayah's `display` string is kept exactly as
   * sent; its words are wrapped in spans (so they can be highlighted) and the spaces and
   * pause marks between them are kept as they are. The ayah number after each ayah is
   * an interface marker, not part of the text.
   *
   * Line breaks: a pause or sajdah mark stays on the line of the word before it (the
   * word, the space and the mark share one unbreakable .qg span), and the ayah number
   * stays on the line of the last word of its ayah (.ayah-end, with a no-break space).
   * Otherwise a number can start the next line and look like the label of the next ayah.
   * Only elements are added around the characters; the text itself is unchanged.
   */
  function renderQuranText() {
    const q = state.quran;
    const box = $('#quran-text');
    box.textContent = '';
    q.words = [];
    for (const ayah of q.ayat) {
      const display = onlyText(ayah.display);
      const expectedWords = Array.isArray(ayah.display_words) ? ayah.display_words : null;
      const ayahNode = el('span', { class: 'ayah', 'data-ayah': ayah.ayah });
      const parts = display.split(/(\s+)/).filter(Boolean);
      let index = 0;
      let group = null; // the .qg of the last word, while pause marks may follow it
      parts.forEach((part, i) => {
        if (/^\s+$/.test(part)) {
          if (group && parts[i + 1] !== undefined && isPauseMark(parts[i + 1])) group.append(part);
          else {
            ayahNode.append(part);
            group = null;
          }
          return;
        }
        if (isPauseMark(part)) {
          (group || ayahNode).append(part);
          return;
        }
        const span = el('span', { class: 'qw', 'data-w': index }, part);
        // Highlighting relies on the server's word indices; only trust them if they agree.
        if (!expectedWords || expectedWords[index] === part) {
          q.words.push({ ayah: ayah.ayah, index, text: part, el: span });
        }
        group = el('span', { class: 'qg' }, span);
        ayahNode.append(group);
        index++;
      });
      const marker = el('span', { class: 'ayah-num', 'aria-label': t('ayah_label', { a: ayah.ayah }) }, arabicDigits(ayah.ayah));
      box.append(el('span', { class: 'ayah-end' }, [ayahNode, '\u00a0', marker]), ' ');
    }
  }

  function quranMode() {
    const r = $('input[name="qmode"]:checked');
    return r && r.value === 'memory' ? 'memory' : 'looking';
  }

  function applyQuranMode() {
    const memory = quranMode() === 'memory';
    const hideText = memory && !state.quran.revealed;
    $('#quran-text').hidden = hideText;
    $('#quran-memory').hidden = !hideText;
    $('#btn-quran-rehide').hidden = !(memory && state.quran.revealed);
    renderHint();
  }

  function renderHint() {
    const q = state.quran;
    const node = $('#quran-hint');
    const words = q.words.slice(q.hintStart, q.hintEnd).map((w) => w.text);
    node.textContent = words.join(' ');
    node.hidden = words.length === 0;
  }

  /** Show the next word of the passage (from memory mode). */
  function revealHint() {
    const q = state.quran;
    if (q.hintEnd >= q.words.length) {
      setStatus($('#quran-status'), 'hint_none');
      return;
    }
    q.hintEnd++;
    renderHint();
  }

  function clearQuranMarks() {
    for (const w of state.quran.words) {
      w.el.className = 'qw';
      w.el.textContent = w.text;
    }
    for (const n of $$('#quran-text ins.w-ins')) n.remove();
  }

  async function checkQuran(blob, info) {
    const q = state.quran;
    const loaded = q.loaded;
    if (!loaded) return;
    const status = $('#quran-status');
    const form = new FormData();
    form.append('audio', blob, 'recitation.wav');
    form.append('surah', String(loaded.surah));
    form.append('from', String(loaded.from));
    form.append('to', String(loaded.to));
    setStatus(status, 'checking');
    let res;
    try {
      res = await api('api/quran/check', { form });
    } catch (err) {
      showError(status, err);
      return;
    }
    clearStatus(status);
    if (q.loaded !== loaded) return;
    showQuranResult(res);
    $('#quran-limit').hidden = !(info && info.limit);
  }

  /**
   * Work out the status of each display word from a /api/quran/check response.
   * Uses `words` when the server sends it, otherwise folds the ops (which carry ayah and
   * word_index_display) the same way. Returns {byWord: Map, insBefore: Map, insEnd: []}.
   */
  function quranWordMarks(res) {
    const byWord = new Map();
    const insBefore = new Map();
    const insEnd = [];
    const key = (a, j) => a + ':' + j;
    if (Array.isArray(res.words) && res.words.length) {
      let pending = [];
      for (const w of res.words) {
        if (w.status === 'ins') {
          if (w.heard) pending.push(onlyText(w.heard));
          continue;
        }
        const k = key(w.ayah, w.word_index_display);
        if (pending.length) {
          insBefore.set(k, pending);
          pending = [];
        }
        byWord.set(k, { status: w.status, heard: w.heard ? onlyText(w.heard) : '' });
      }
      insEnd.push(...pending);
      return { byWord, insBefore, insEnd };
    }
    const groups = new Map();
    let pending = [];
    for (const op of res.ops || []) {
      if (op.kind === 'ins') {
        if (op.heard) pending.push(onlyText(op.heard));
        continue;
      }
      if (op.ayah === null || op.ayah === undefined || op.word_index_display === null || op.word_index_display === undefined) continue;
      const k = key(op.ayah, op.word_index_display);
      if (pending.length) {
        insBefore.set(k, (insBefore.get(k) || []).concat(pending));
        pending = [];
      }
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(op);
    }
    insEnd.push(...pending);
    for (const [k, ops] of groups) {
      const kinds = new Set(ops.map((o) => o.kind));
      const status = kinds.size === 1 && kinds.has('match') ? 'match' : kinds.size === 1 && kinds.has('del') ? 'del' : 'sub';
      const heard = ops.map((o) => o.heard).filter(Boolean).join(' ');
      byWord.set(k, { status, heard });
    }
    return { byWord, insBefore, insEnd };
  }

  function showQuranResult(res) {
    const q = state.quran;
    const sayAgain = !!res.say_again || res.verdict === 'unclear';
    clearQuranMarks();
    if (!sayAgain) {
      const { byWord, insBefore, insEnd } = quranWordMarks(res);
      let last = 'match';
      for (const w of q.words) {
        const k = w.ayah + ':' + w.index;
        const extra = insBefore.get(k);
        if (extra) {
          for (const heard of extra) w.el.before(quranIns(heard));
        }
        const mark = byWord.get(k);
        // A display word with no match word of its own shares the status before it.
        const status = mark ? mark.status : last;
        last = status;
        markQuranWord(w, status, mark ? mark.heard : '');
      }
      if (insEnd.length && q.words.length) {
        const lastWord = q.words[q.words.length - 1].el;
        for (const heard of insEnd.slice().reverse()) lastWord.after(quranIns(heard));
      }
      if (quranMode() === 'memory') q.revealed = true;
    }
    const fb = $('#quran-feedback');
    fb.textContent = onlyText(res.feedback); // fixed Arabic template; shown as text only
    const fe = res.first_error;
    const feNode = $('#quran-first-error');
    if (fe && fe.ayah && !sayAgain) {
      setT(feNode, 'first_error_at', { a: Number(fe.ayah) });
      feNode.hidden = false;
      const target = q.words.find((w) => w.ayah === fe.ayah && w.index === fe.word_index_display);
      if (target) target.el.classList.add('w-first');
    } else {
      setT(feNode, null);
      feNode.hidden = true;
    }
    $('#quran-say-again').hidden = !sayAgain;
    const box = $('#quran-result');
    box.hidden = false;
    applyQuranMode();
    box.focus({ preventScroll: true });
    // As on the recite screen: on a phone the result card starts below the fold (under
    // the sticky record bar), so bring the feedback into view.
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function quranIns(heard) {
    return el('ins', { class: 'w w-ins' }, [srOnly('(' + t('sr_extra') + ' '), '[' + heard + ']', srOnly(')')]);
  }

  function markQuranWord(w, status, heard) {
    const node = w.el;
    node.textContent = w.text;
    if (status === 'match') {
      node.className = 'qw w w-match';
    } else if (status === 'del') {
      node.className = 'qw w w-del';
      node.append(srOnly(' (' + t('sr_skipped') + ')'));
    } else {
      node.className = 'qw w w-sub';
      node.textContent = '';
      node.append(el('span', { class: 'w-exp' }, w.text));
      if (heard) node.append(srOnly(' (' + t('sr_heard') + ' '), el('span', { class: 'w-heard' }, heard), srOnly(')'));
    }
  }

  async function locateQuran(blob) {
    const status = $('#quran-where-status');
    const form = new FormData();
    form.append('audio', blob, 'recitation.wav');
    if ($('#quran-where-surah').checked && state.quran.loaded) form.append('surah', String(state.quran.loaded.surah));
    setStatus(status, 'locating');
    let res;
    try {
      res = await api('api/quran/locate', { form });
    } catch (err) {
      showError(status, err);
      return;
    }
    const list = $('#quran-where-list');
    list.textContent = '';
    const candidates = Array.isArray(res.candidates) ? res.candidates.slice(0, 3) : [];
    if (!candidates.length) {
      setStatus(status, 'not_found');
      list.hidden = true;
      return;
    }
    clearStatus(status);
    for (const c of candidates) {
      const info = surahInfo(c.surah);
      const name = info ? info.name_ar : String(c.surah);
      const title = el('p', { class: 'cand-title' });
      setT(title, 'found_at', { name, s: Number(c.surah), a: Number(c.ayah) });
      const preview = el('p', { class: 'cand-preview quran-font', lang: 'ar', dir: 'rtl' }, onlyText(c.display_preview));
      const btn = el('button', { type: 'button', class: 'btn btn-small' });
      setT(btn, 'go_there');
      btn.addEventListener('click', () => goToAyah(c));
      list.append(el('li', { class: 'candidate' }, [title, preview, btn]));
    }
    list.hidden = false;
  }

  async function goToAyah(c) {
    const info = surahInfo(c.surah);
    if (!info) return;
    const prefs = state.profile.quran;
    if (info.number < JUZ_AMMA_FIRST && prefs.juzAmma) prefs.juzAmma = false;
    prefs.surah = info.number;
    prefs.from = clampInt(c.ayah, 1, info.ayah_count, 1);
    prefs.to = Math.min(info.ayah_count, prefs.from + DEFAULT_RANGE - 1);
    saveProfile();
    renderSurahOptions();
    await loadAyat();
    const q = state.quran;
    const start = q.words.findIndex((w) => w.ayah === prefs.from && w.index >= (Number(c.word_index) || 0));
    q.hintStart = Math.max(0, start);
    q.hintEnd = q.hintStart;
    renderHint();
  }

  // ===========================================================================
  // Boot
  // ===========================================================================

  function init() {
    state.profile = loadProfile();
    state.page.lang = state.profile.lang;
    initStart();
    initPrepare();
    initRecite();
    initDictation();
    initQuran();

    for (const btn of $$('[data-go]')) {
      btn.addEventListener('click', () => go(btn.dataset.go));
    }
    $('#btn-profile').addEventListener('click', () => {
      state.started = true;
      go('start');
    });
    $('#btn-retry').addEventListener('click', loadHealth);
    window.addEventListener('hashchange', onHashChange);
    // Release the microphone if the page is hidden or closed mid-recording.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        cancelRecording();
        player.stop();
      }
    });
    window.addEventListener('pagehide', () => cancelRecording());

    applyStrings();
    // The AI disclosure is shown at the start of every session.
    if (location.hash && location.hash !== '#start') history.replaceState(null, '', '#start');
    showScreen('start');
    loadHealth();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
