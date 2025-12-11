---
layout: default  # Ensures home uses theme's default layout
---

# Welcome to Galt's Gulch Code

Critical, no-compromise explorations of Rust, Java, and systems programming.

## Latest Articles

{% for post in site.posts limit:5 %}
<article>
  <header>
    <h2><a href="{{ post.url }}">{{ post.title }}</a></h2>
    <p>{{ post.date | date: "%B %d, %Y" }}</p>
  </header>
  {% if post.excerpt %}
  <p>{{ post.excerpt | strip_html | truncate: 150 }}...</p>
  {% endif %}
</article>
{% endfor %}

{% if site.posts.size == 0 %}
No articles yet—check back soon!
{% endif %}