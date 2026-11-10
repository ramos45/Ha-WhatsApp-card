# Ha-WhatsApp-card

# Card de Lovelace "WhatsApp Chat" para el add-on de WhatsApp

Os comparto una card personalizada para Home Assistant que da al add-on una interfaz con aspecto de WhatsApp: lista de chats, conversaciones, agenda y estado de los mensajes. Funciona con el add-on `whatsapp_addon` y usa sus eventos y el servicio `whatsapp.send_message`.

## Funciones

- **Modo bandeja (`mode: inbox`)**: lista de chats ordenada por último mensaje, con foto, vista previa, hora y contador de no leídos. Buscador y flecha para volver atrás, como en la app.
- **Modo contacto único (`mode: chat`)**: un chat fijo con un contacto.
- **Chat nuevo y chats temporales**: escribes un teléfono (con o sin prefijo) y abres el chat. Puedes guardarlo en la agenda o dejarlo temporal.
- **Agenda**: contactos guardados, renombrables, más una lista fija en YAML (`contacts`).
- **Nombres y LID automáticos**: usa el nombre de perfil del contacto y enlaza solo el LID con el teléfono cuando el evento trae `senderPn`. Envía por LID si lo conoce.
- **Estado de los mensajes**: ✓ enviado, ✓✓ entregado, ✓✓ azul leído (evento `whatsapp_message_status`, add-on 2.5.0 o superior).
- **Chats ocultos**: oculta un contacto para que no aparezca en la lista (sus mensajes se siguen guardando) y muéstralo más tarde. También por YAML con `hidden_contacts`.
- **Limpieza**: vaciar un chat, eliminar un contacto, vaciar todos los mensajes o borrar todo. Solo afecta al historial de la card, no a WhatsApp.
- **Depuración**: panel con el último evento recibido y botón para copiarlo. Indica por qué se ignora un evento.
- Modo claro y oscuro automático, y editor visual.

## Instalación

1. Copia `whatsapp-chat-card.js` a `/config/www/`.
2. Ajustes → Paneles → ⋮ → Recursos → añade `/local/whatsapp-chat-card.js?v=5` como **módulo JavaScript**.
3. Recarga el navegador (o reinicia la app móvil) y añade la card "WhatsApp Chat".

## Ejemplo

```yaml
type: custom:whatsapp-chat-card
mode: inbox
title: WhatsApp
user_name: Yo
country_code: "34"
height: 560
contacts:
  - name: Mamá
    phone: "600111222"
hidden_contacts:
  - "600999888"
```

Un solo contacto:

```yaml
type: custom:whatsapp-chat-card
contact_name: Mamá
contact_phone: "600111222"
country_code: "34"
```

Otras opciones: `client_id`, `prefer_lid`, `sync`, `debug`, `user_avatar`, `event_type`, `sent_event_type`, `status_event_type`.

## Cómo funciona

- Recibe con `new_whatsapp_message`, `whatsapp_message_sent` y `whatsapp_message_status`.
- Envía con `whatsapp.send_message` (`clientId`, `to`, `body.text`).
- El historial y la agenda se guardan en el navegador y, si está disponible, se sincronizan entre dispositivos con los datos de usuario de Home Assistant.

## Limitaciones

- Solo texto: las imágenes, audios y similares aparecen como "📎 tipo".
- Los grupos se ignoran.
- Los tics de estado necesitan el add-on 2.5.0 o superior.
- No marca como leídos los mensajes recibidos en WhatsApp.

Cualquier fallo o sugerencia es bienvenido. Si algo no encaja con el formato de vuestros eventos, activad la depuración y pegad aquí el JSON que muestra.

# "WhatsApp Chat" Lovelace card for the WhatsApp add-on

I'm sharing a custom Home Assistant card that gives the add-on a WhatsApp-style interface: chat list, conversations, address book and message status. It works with the `whatsapp_addon` add-on and uses its events and the `whatsapp.send_message` service.

## Features

- **Inbox mode (`mode: inbox`)**: chat list sorted by last message, with avatar, preview, time and unread badge. Search and a back arrow, like the app.
- **Single-contact mode (`mode: chat`)**: one fixed chat with one contact.
- **New chat and temporary chats**: type a phone number (with or without country code) and open the chat. Save it to the address book or keep it temporary.
- **Address book**: saved, renameable contacts, plus a fixed YAML list (`contacts`).
- **Automatic names and LIDs**: uses the contact's profile name and links the LID to the phone number on its own when the event carries `senderPn`. Sends via LID when known.
- **Message status**: ✓ sent, ✓✓ delivered, blue ✓✓ read (`whatsapp_message_status` event, add-on 2.5.0 or later).
- **Hidden chats**: hide a contact so it doesn't show in the list (its messages are still stored) and show it again later. Also available in YAML with `hidden_contacts`.
- **Clean-up**: clear a chat, delete a contact, clear all messages, or wipe everything. It only affects the card's history, not WhatsApp.
- **Debugging**: panel with the last received event and a copy button. It explains why an event is ignored.
- Automatic light and dark mode, and a visual editor.

## Installation

1. Copy `whatsapp-chat-card.js` to `/config/www/`.
2. Settings → Dashboards → ⋮ → Resources → add `/local/whatsapp-chat-card.js?v=5` as a **JavaScript module**.
3. Reload the browser (or restart the mobile app) and add the "WhatsApp Chat" card.

## Example

```yaml
type: custom:whatsapp-chat-card
mode: inbox
title: WhatsApp
user_name: Me
country_code: "34"
height: 560
contacts:
  - name: Mom
    phone: "600111222"
hidden_contacts:
  - "600999888"
```

Single contact:

```yaml
type: custom:whatsapp-chat-card
contact_name: Mom
contact_phone: "600111222"
country_code: "34"
```

Other options: `client_id`, `prefer_lid`, `sync`, `debug`, `user_avatar`, `event_type`, `sent_event_type`, `status_event_type`.

## How it works

- Receives via `new_whatsapp_message`, `whatsapp_message_sent` and `whatsapp_message_status`.
- Sends via `whatsapp.send_message` (`clientId`, `to`, `body.text`).
- History and address book are kept in the browser and, when available, synced across devices using Home Assistant's user data.

## Limitations

- Text only: images, audio and similar show as "📎 type".
- Groups are ignored.
- Status ticks need add-on 2.5.0 or later.
- It does not mark messages received on WhatsApp as read.

Bug reports and suggestions are welcome. If something doesn't match your event format, turn on debug mode and paste the JSON it shows here.
