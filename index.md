---
layout: default
title: "Engineering, business, and art"
---
<section class="hero">
<div><p class="eyebrow">ENGINEERING · BUSINESS · ART</p><h1>How do things work?<br>Why do they fail?<br><em>What can we learn?</em></h1><p class="intro">A personal notebook about software, the business of making things, and the art of paying attention.</p></div>
<div class="composition" aria-hidden="true"><div class="orb"></div><div class="note">observe<br>↘<br>build → reflect<br><br>repeat.</div><span>FIG. 01 — A WORK IN PROGRESS</span></div>
</section>
<section class="notebook" aria-labelledby="notebook-heading"><div class="notebook-header"><h2 id="notebook-heading" class="eyebrow">What are we exploring?</h2><div class="filters" role="group" aria-label="Filter writing by topic" hidden><button type="button" data-filter="all" aria-pressed="true">All</button><button type="button" data-filter="engineering" aria-pressed="false">Engineering</button><button type="button" data-filter="business" aria-pressed="false">Business</button><button type="button" data-filter="art" aria-pressed="false">Art</button></div></div>
<div class="post-list">
{% for post in site.posts %}
<article class="post-preview" data-topic="{{ post.topic | default: 'engineering' | downcase | escape }}"><p class="post-meta">{{ post.topic | default: 'Engineering' }} <span>·</span> <time datetime="{{ post.date | date_to_xmlschema }}">{{ post.date | date: '%b %-d, %Y' }}</time> <span>·</span> {% assign minutes = post.content | strip_html | number_of_words | divided_by: 200 | plus: 1 %}{{ minutes }} min read</p><h3><a href="{{ post.url | relative_url }}">{{ post.title | escape }}</a></h3><p>{{ post.excerpt | strip_html }}</p></article>
{% endfor %}
</div><p class="empty-state" role="status" hidden>No essays here yet. This part of the notebook is still taking shape.</p><p class="filter-status visually-hidden" role="status" aria-live="polite"></p></section>
