PDF fonts (embedded into every generated PDF through @font-face data URIs).

Default: DejaVu Sans Regular + Bold (free licence, see DEJAVU-LICENSE.txt). It covers Arabic and Latin and
shapes correctly in Chromium, but its Arabic letterforms are plain.

To use a nicer Arabic font (Cairo, Noto Naskh Arabic, Amiri, Tajawal ... all SIL OFL), download a Regular and a
Bold .ttf, put them in this folder and set in backend/.env:
  PDF_FONT_REGULAR=assets/fonts/Cairo-Regular.ttf
  PDF_FONT_BOLD=assets/fonts/Cairo-Bold.ttf
Paths are relative to the backend folder. Restart the server.
