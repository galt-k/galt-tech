# GaltSystems

A light, responsive Jekyll notebook about engineering, business, and art.

## Local development

Use Ruby 3.1 or later, then run `bundle install` and `bundle exec jekyll serve`.
Open http://localhost:4000/galt-tech/.

## Writing

Add Markdown posts in `_posts` with a `title` phrased as a problem-focused question,
`date`, a short `excerpt`, and `topic: Engineering`, `Business`, or `Art`.
The homepage lists posts automatically. Topic filters are progressively enhanced;
all posts remain available without JavaScript. Existing post filenames determine
stable URLs, so changing titles does not break article links.

The default layout includes SEO, RSS, and sitemap plugins. The design uses local
CSS and JavaScript, system fonts, and no remote theme. Background colors remain
light regardless of system appearance. The custom single layout adds an optional
table of contents and scrollable tables.
