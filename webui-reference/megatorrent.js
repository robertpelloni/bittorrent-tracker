'use strict'

/* global $$, $, Element, fetch */

window.addEvent('domready', function () {
  const tabLink = $('megatorrentTabLink')
  if (tabLink) {
      tabLink.addEvent('click', function () {
        loadMegatorrentTab()
      })
  }
})

function loadMegatorrentTab () {
  $$('.tab-content').setStyle('display', 'none')
  $$('.toolbarTabs li').removeClass('selected')
  $('megatorrentTabLink').addClass('selected')

  let container = $('megatorrentContainer')
  if (!container) {
    container = new Element('div', {
      id: 'megatorrentContainer',
      class: 'tab-content',
      styles: { padding: '20px', color: '#ccc' }
    }).inject($('pageWrapper'))

    renderMegatorrentUI(container)
  }
  container.setStyle('display', 'block')
  refreshSubscriptions()
}

function renderMegatorrentUI (container) {
  container.innerHTML = `
        <h2>Megatorrent Subscriptions</h2>
        <div style="margin-bottom: 20px;">
            <input type="text" id="megaUriInput" placeholder="megatorrent://<pubkey>" style="width: 300px; padding: 5px;">
            <button id="megaSubscribeBtn" style="padding: 5px 10px;">Subscribe</button>
            <span id="megaStatus" style="margin-left: 20px;"></span>
        </div>

        <table class="dynamicTable" style="width: 100%;">
            <thead>
                <tr>
                    <th>Public Key</th>
                    <th>Label</th>
                    <th>Last Sequence</th>
                    <th>Action</th>
                </tr>
            </thead>
            <tbody id="megaSubsList"></tbody>
        </table>
    `

  document.getElementById('megaSubscribeBtn').addEventListener('click', function () {
    const uri = document.getElementById('megaUriInput').value
    if (uri) addSubscription(uri).then(refreshSubscriptions)
  })
}

async function addSubscription (uri) {
    try {
      // Parse URI to get Key
      let publicKey = uri
      if (uri.startsWith('megatorrent://')) {
          const parts = uri.replace('megatorrent://', '').split('/')
          const auth = parts[0].split(':')
          publicKey = auth[0]
      }
      const label = uri // or prompt user

      const response = await fetch('api/v2/megatorrent/addSubscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          publicKey: publicKey,
          label: label
        })
      })

      if (!response.ok) throw new Error(response.statusText)
      return true
    } catch (e) {
      console.error('Add Subscription Error:', e)
      alert('Failed to add subscription: ' + e.message)
      return false
    }
}

async function removeSubscription (publicKey) {
    if (!confirm('Remove subscription?')) return;
    try {
      const response = await fetch('api/v2/megatorrent/removeSubscription', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ publicKey })
      })
      if (!response.ok) throw new Error(response.statusText)
      refreshSubscriptions()
    } catch (e) {
        console.error(e)
    }
}

async function refreshSubscriptions () {
  try {
    const response = await fetch('api/v2/megatorrent/getSubscriptions')
    if (!response.ok) throw new Error('API Error')
    const subs = await response.json() // Expect Array

    const list = document.getElementById('megaSubsList')
    list.innerHTML = ''

    if (subs.length === 0) {
      list.innerHTML = '<tr><td colspan="4" style="text-align:center">No subscriptions</td></tr>'
    } else {
      subs.forEach(sub => {
        const row = document.createElement('tr')
        row.innerHTML = `
                <td>${sub.publicKey.substring(0, 20)}...</td>
                <td>${sub.label}</td>
                <td>${sub.lastSequence}</td>
                <td><button onclick="removeSubscription('${sub.publicKey}')">Remove</button></td>
            `
        // Note: onclick with global function requires attaching to window or rewrite.
        // For reference, simple addEventListener is safer.
        const btn = row.querySelector('button')
        btn.addEventListener('click', () => removeSubscription(sub.publicKey))

        list.appendChild(row)
      })
    }
  } catch (e) {
    document.getElementById('megaStatus').innerText = 'Daemon Offline / API Error'
  }
}
