(() => {
  const filters = document.querySelector('.filters');
  if (filters) {
    const posts = [...document.querySelectorAll('[data-topic]')];
    filters.hidden = false;
    filters.addEventListener('click', event => {
      const button = event.target.closest('[data-filter]');
      if (!button) return;
      filters.querySelectorAll('button').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      let count = 0;
      posts.forEach(post => {
        post.hidden = button.dataset.filter !== 'all' && post.dataset.topic !== button.dataset.filter;
        if (!post.hidden) count++;
      });
      document.querySelector('.empty-state').hidden = count > 0;
      document.querySelector('.filter-status').textContent = `${count} ${count === 1 ? 'article' : 'articles'} shown.`;
    });
  }
  const contents = document.querySelector('.contents');
  if (contents) {
    const headings = [...document.querySelectorAll('.prose h2')];
    if (headings.length) {
      const list = document.createElement('ol');
      headings.forEach((heading, index) => {
        if (!heading.id) heading.id = `section-${index + 1}`;
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = `#${heading.id}`;
        link.textContent = heading.textContent;
        item.append(link); list.append(item);
      });
      contents.querySelector('nav').append(list);
      contents.hidden = false;
    }
  }
  document.querySelectorAll('.prose table').forEach(table => {
    const wrapper = document.createElement('div');
    wrapper.className = 'table-scroll';
    wrapper.tabIndex = 0;
    wrapper.setAttribute('role', 'region');
    wrapper.setAttribute('aria-label', 'Scrollable article table');
    table.before(wrapper); wrapper.append(table);
  });
})();
