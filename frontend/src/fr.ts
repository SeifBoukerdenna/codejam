// French for the app's own words (see i18n.tsx). Keyed by the English text. Quebec usage: courriel, fournisseur,
// virement, libérer un paiement. A key with "|context" is an English word French has to say two ways.

export const FR: Record<string, string> = {
  // ── Frame: menu, search, user ──
  "Home": "Accueil", "Inbox": "Boîte de réception", "Approvals": "Approbations", "Payments": "Paiements", "Bank": "Banque",
  "Vendors": "Fournisseurs", "Activity": "Activité", "Try to fool us": "Essayez de nous tromper", "System health": "Santé du système",
  "Inbox|tab": "Boîte", "Vendors|tab": "Fourn.", "Approve": "Approuver", "Pay": "Payer", "Audit": "Audit", "Fool us": "Tromper", "Health": "Santé",
  "Search": "Rechercher", "Search, or switch user": "Rechercher ou changer d'utilisateur", "Today is {date}": "Nous sommes le {date}",
  "Choose who you are": "Qui êtes-vous ?", "Act as user": "Agir en tant que", "Loading": "Chargement",
  "Couldn't load this page": "Impossible de charger cette page",

  // ── Roles and people ──
  "Employee": "Employé·e", "AP clerk": "Commis aux comptes fournisseurs", "Department manager": "Gestionnaire de service",
  "Finance manager": "Gestionnaire des finances", "Controller": "Contrôle financier", "Auditor · read-only": "Audit · lecture seule",
  "CFO": "Direction financière", "on leave": "en congé", "terminated": "parti·e", "you": "vous", "Unknown vendor": "Fournisseur inconnu",

  // ── Status words (one vocabulary, format.ts) ──
  "Reading": "En lecture", "Needs review": "À vérifier", "On hold": "En suspens", "Waiting for approval": "En attente d'approbation",
  "Approved": "Approuvée", "Scheduled": "Paiement prévu", "Paid": "Payée", "Rejected": "Rejetée",
  "Waiting for release": "À libérer", "Sent": "Envoyé", "Scheduled|payment": "Prévu", "Cheque not cashed": "Chèque non encaissé",
  "Paid|payment": "Payé", "Stopped": "Arrêté", "Active": "Actif", "Pending review": "À examiner",
  "Passed": "Réussi", "Needs a look": "À examiner", "Blocks": "Bloque", "Note": "Note",
  "Bank transfer": "Virement", "Cheque": "Chèque", "Virtual card": "Carte virtuelle",

  // ── Home ──
  "Good morning": "Bonjour", "Good afternoon": "Bon après-midi", "Good evening": "Bonsoir",
  "Choose who you are to see your work": "Choisissez qui vous êtes pour voir votre travail",
  "Paid to vendors this year": "Payé aux fournisseurs cette année", "As of {date}": "Au {date}",
  "{n} payments": "{n} paiements", "so far this month": "depuis le début du mois",
  "in the last month": "au cours du dernier mois", "in the last 3 months": "au cours des 3 derniers mois", "this year": "cette année",
  "1M": "1 m", "3M": "3 m", "YTD": "Année", "Chart range": "Période du graphique",
  "Money paid out, running total, {range}. Use the arrow keys to read values.":
    "Montants payés, total cumulé, {range}. Utilisez les flèches pour lire les valeurs.",
  "For you": "Pour vous", "Read-only access.": "Accès en lecture seule.", "You're all caught up.": "Vous êtes à jour.",
  "Email to sort": "Courriel à trier", "Emails to sort": "Courriels à trier", "Reply to send": "Réponse à envoyer",
  "Replies to send": "Réponses à envoyer", "Invoice to review": "Facture à vérifier", "Invoices to review": "Factures à vérifier",
  "Invoice on hold": "Facture en suspens", "Invoices on hold": "Factures en suspens", "Invoice to approve": "Facture à approuver",
  "Invoices to approve": "Factures à approuver", "Payment to release": "Paiement à libérer", "Payments to release": "Paiements à libérer",
  "Approved invoice to pay": "Facture approuvée à payer", "Approved invoices to pay": "Factures approuvées à payer",
  "Payment held": "Paiement en suspens", "Payments held": "Paiements en suspens",
  "Bank debit to explain": "Débit bancaire à expliquer", "Bank debits to explain": "Débits bancaires à expliquer",
  "Money to get back": "Argent à récupérer", "Paid twice": "Payé en double", "{n} still to recover": "{n} encore à récupérer",
  "All recovered": "Tout récupéré", "Tax we can't claim back": "Taxes non récupérables",
  "{n} invoice to fix": "{n} facture à corriger", "{n} invoices to fix": "{n} factures à corriger",
  "Waiting for the bank's answer": "En attente de la réponse de la banque", "Ask the bank": "Demander à la banque",
  "{month} so far": "{month} jusqu'ici", "This month": "Ce mois-ci", "Paid out": "Payé", "Scheduled to go out": "Prévu à payer",
  "Going out next": "Prochains paiements", "See all": "Tout voir",

  // ── Inbox ──
  "Invoice": "Facture", "Statement": "Relevé", "Newsletter": "Infolettre", "Payment question": "Question de paiement",
  "No attachment": "Sans pièce jointe", "Needs a person": "Demande une personne",
  "Vendor": "Fournisseur", "Invoice date": "Date de facture", "Status": "Statut", "Amount": "Montant",
  "Invoice {number}": "Facture {number}", "Credit note {number}": "Note de crédit {number}",
  "Answered": "Répondu", "Reply ready": "Réponse prête", "{n} invoices": "{n} factures", "{n} invoice": "{n} facture",
  "attachments": "pièces jointes", "Sorted": "Triés", "{n} emails waiting to be sorted.": "{n} courriels à trier.",
  "Invoices": "Factures", "Payment questions": "Questions de paiement", "Missing attachment": "Pièce jointe manquante",
  "Statements": "Relevés", "Newsletters": "Infolettres", "Documents read": "Documents lus", "Read": "Lus",
  "{done} of {total}": "{done} sur {total}", "{done} of {total} documents read": "{done} documents lus sur {total}",
  "Inbox sorted. Reading the invoices now…": "Courriels triés. Lecture des factures en cours…",
  "See what needs review": "Voir ce qui est à vérifier", "Sort {n} new email": "Trier {n} nouveau courriel",
  "Sort {n} new emails": "Trier {n} nouveaux courriels", "Uploaded. Reading it now…": "Téléversée. Lecture en cours…",
  "Upload an invoice": "Téléverser une facture", "Reading {n} document…": "Lecture de {n} document…",
  "Reading {n} documents…": "Lecture de {n} documents…", "Couldn't read {file}": "Impossible de lire {file}",
  "Inbox view": "Vue de la boîte", "To review": "À vérifier", "To answer": "À répondre", "Emails": "Courriels",
  "Nothing to review": "Rien à vérifier", "Sort the inbox to bring new invoices in.": "Triez les courriels pour faire entrer les nouvelles factures.",
  "Nothing on hold": "Rien en suspens", "Nothing to answer": "Rien à répondre",
  "Reply sent": "Réponse envoyée", "Reply ready to send": "Réponse prête à envoyer", "Marked as answered": "Marqué comme répondu",
  "Mark as answered": "Marquer comme répondu", "Answered by {name}": "Répondu par {name}", "Their email": "Leur courriel",
  "Invoices from this email": "Factures de ce courriel", "Attachments": "Pièces jointes", "Open": "Ouvrir",
  "To": "À", "Subject": "Objet", "Copy": "Copier", "Copied": "Copié", "Couldn't copy": "Impossible de copier",
  "Open in mail app": "Ouvrir dans le courriel",

  // ── Approvals ──
  "Who are you?": "Qui êtes-vous ?", "Choose a user to see what's waiting for them.": "Choisissez un utilisateur pour voir ce qui l'attend.",
  "Your step": "Votre étape", "for {name}": "pour {name}", "How approval works": "Comment fonctionne l'approbation",
  "Up to $10,000": "Jusqu'à 10 000 $", "Over $10,000": "Plus de 10 000 $", "Over $50,000": "Plus de 50 000 $",
  "Over $250,000": "Plus de 250 000 $", "Manager": "Gestionnaire", "+ Finance": "+ Finances", "+ Controller": "+ Contrôle",
  "+ CFO": "+ Direction financière",
  "Nobody approves their own request, or two steps of the same invoice.":
    "Personne n'approuve sa propre demande, ni deux étapes de la même facture.",
  "You're all caught up": "Vous êtes à jour", "Nothing is waiting for you.": "Rien ne vous attend.",
  "Waiting for your approval": "En attente de votre approbation",
  "Invoices waiting for your approval": "Factures en attente de votre approbation",

  // ── Payments ──
  "Ready to pay": "Prêts à payer", "To release": "À libérer", "Going out": "En route", "Uncashed cheques": "Chèques non encaissés",
  "Paid|payments": "Payés", "Approved, not paid yet": "Approuvé, pas encore payé", "Waiting to be released": "En attente de libération",
  "Cheques not cashed yet": "Chèques pas encore encaissés",
  "Nothing waiting to be paid": "Rien à payer", "Nothing to release": "Rien à libérer", "Nothing going out": "Rien en route",
  "No uncashed cheques": "Aucun chèque non encaissé", "Nothing paid yet": "Rien de payé pour l'instant",
  "Approved invoices wait here until AP prepares their payment.": "Les factures approuvées attendent ici que les CF préparent leur paiement.",
  "Payments AP prepares wait here for a finance manager or controller to release them.":
    "Les paiements préparés par les CF attendent ici qu'une personne des finances ou du contrôle les libère.",
  "A payment is held when its vendor or bank details aren't safe to pay yet.":
    "Un paiement est suspendu quand son fournisseur ou ses coordonnées bancaires ne sont pas encore sûrs.",
  "Released and scheduled payments show here until the bank confirms them.":
    "Les paiements libérés et prévus restent ici jusqu'à la confirmation de la banque.",
  "Every cheque we sent has been cashed.": "Tous nos chèques ont été encaissés.",
  "Paid invoices and their payments show here.": "Les factures payées et leurs paiements apparaissent ici.",
  "Method": "Mode", "Date": "Date", "Paid|date": "Payé le",
  "About to pay {vendor} twice": "Sur le point de payer {vendor} deux fois",
  "Invoice {number}: {payments} are both scheduled. Stop one:": "Facture {number} : {payments} sont tous deux prévus. Arrêtez-en un :",
  " and ": " et ", "Money going out": "Argent qui sort", "Released or scheduled": "Libéré ou prévu", "Total going out": "Total qui sort",
  "Credits waiting": "Crédits en attente", "Deducted automatically from the next payment to {vendors}.":
    "Déduits automatiquement du prochain paiement à {vendors}.",
  "This year": "Cette année", "Early-payment discounts taken ({n})": "Escomptes de paiement hâtif obtenus ({n})",
  "Discounts missed ({n})": "Escomptes manqués ({n})",
  "Sent by transfer or cheque to vendors who take cards ({n})": "Payé par virement ou chèque à des fournisseurs qui acceptent la carte ({n})",
  "Card rewards at your rate ({rate})": "Récompenses de carte à votre taux ({rate})", "{vendors} take cards.": "{vendors} acceptent la carte.",
  "Simulated EFT, cheque and virtual card. No real money moves.": "Virement, chèque et carte virtuelle simulés. Aucun argent réel ne bouge.",
  "Payment status": "Statut du paiement", "{n} payment": "{n} paiement", "next {date}": "prochain le {date}",
  "One invoice is scheduled twice": "Une facture est prévue deux fois",
  "See the panel on the right before anything goes out.": "Voyez le panneau de droite avant que quoi que ce soit ne sorte.",
  "{tab} payments": "Paiements : {tab}", "How to pay them": "Comment les payer", "Advice only: you still choose": "Conseil seulement : vous décidez",
  "{method} by {date}": "{method} d'ici le {date}", "{method} on {date}": "{method} le {date}", "saves": "économise",
  "Use this": "Utiliser",

  // ── Search palette ──
  "Search and switch user": "Rechercher et changer d'utilisateur",
  "Invoice number, vendor, amount, page… or “as Elise”": "Numéro de facture, fournisseur, montant, page… ou « as Elise »",
  "Search, or type “as” and a name to switch user": "Rechercher, ou tapez « as » et un nom pour changer d'utilisateur",
  "Results": "Résultats", "Recent": "Récents", "Go to": "Aller à", "Switch user": "Changer d'utilisateur", "Switch": "Changer",
  "Actions": "Actions", "credit note": "note de crédit", "invoice": "facture", "Looks like {name}, but isn't": "Ressemble à {name}, mais n'en est pas",
  "Switch user…": "Changer d'utilisateur…", "Type “as” and a name or a role": "Tapez « as » et un nom ou un rôle",
  "Read new emails": "Lire les nouveaux courriels", "Sort the inbox and start reading the invoices": "Trier les courriels et lire les factures",
  "Inbox read": "Courriels lus", "See the inbox": "Voir la boîte", "Verify the audit log": "Vérifier le journal d'audit",
  "Check every signed event, oldest to newest": "Vérifier chaque événement signé, du plus ancien au plus récent",
  "The audit log is intact: {n} events checked.": "Le journal d'audit est intact : {n} événements vérifiés.",
  "You're now {name} ({role}).": "Vous êtes maintenant {name} ({role}).",
  "Nothing matches “{q}”. Try an invoice number, a vendor, an amount like 6452.30, or “as” and a name.":
    "Rien ne correspond à « {q} ». Essayez un numéro de facture, un fournisseur, un montant comme 6452.30, ou « as » et un nom.",
  "Searching…": "Recherche…", "to move": "pour se déplacer", "to open": "pour ouvrir", "Type": "Tapez",
  "and a name to switch user": "et un nom pour changer d'utilisateur",
  "Inbox: needs review": "Boîte : à vérifier", "Inbox: on hold": "Boîte : en suspens", "Inbox: replies to send": "Boîte : réponses à envoyer",
  "Inbox: all emails": "Boîte : tous les courriels", "Payments: ready to pay": "Paiements : prêts à payer",
  "Payments: waiting for release": "Paiements : à libérer", "Payments: on hold": "Paiements : en suspens",
  "Bank statement": "Relevé bancaire", "Tax credits at risk": "Crédits de taxe à risque", "Audit log": "Journal d'audit",

  // ── Shared ──
  "Nothing here": "Rien ici", "Use j and k or the arrow keys to move, Enter to open.":
    "Utilisez j et k ou les flèches pour vous déplacer, Entrée pour ouvrir.",
  "just now": "à l'instant", "{n} min ago": "il y a {n} min", "{n} h ago": "il y a {n} h",
};
