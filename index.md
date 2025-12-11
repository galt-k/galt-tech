---
layout: home  # Or 'default' if 'home' not available; try both
---

# Welcome to Galt's Gulch Code

Critical, no-compromise explorations of Rust, Java, and systems programming.

## Latest Articles

{% for post in site.posts %}
- [{{ post.title }}]({{ post.url }}) – {{ post.date | date: "%B %d, %Y" }}
{% endfor %}

{% if site.posts.size == 0 %}
No articles yet—check back soon!
{% endif %}