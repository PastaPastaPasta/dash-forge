/**
 * GitHub's emoji shortcodes (`:tada:` → 🎉), the ones in common use: GitHub's full list is ~1,900
 * names (`GET /emojis`), most of which never appear in an issue. A name not listed stays text,
 * as an unknown name does on GitHub. Generated from GitHub's list (their Unicode code points).
 *
 * Loaded by plain Node (type stripping) through `markdown.ts`: keep it erasable.
 */

const TABLE =
  '+1:👍 -1:👎 thumbsup:👍 thumbsdown:👎 tada:🎉 rocket:🚀 heart:❤️ smile:😄 smiley:😃 grinning:😀 grin:😁 ' +
  'laughing:😆 joy:😂 rofl:🤣 wink:😉 blush:😊 relaxed:☺️ slightly_smiling_face:🙂 upside_down_face:🙃 ' +
  'sweat_smile:😅 sunglasses:😎 heart_eyes:😍 thinking:🤔 confused:😕 worried:😟 disappointed:😞 cry:😢 ' +
  'sob:😭 sweat:😓 rage:😡 angry:😠 scream:😱 sleeping:😴 zzz:💤 neutral_face:😐 expressionless:😑 ' +
  'unamused:😒 roll_eyes:🙄 face_with_head_bandage:🤕 mask:😷 nerd_face:🤓 partying_face:🥳 ' +
  'exploding_head:🤯 shushing_face:🤫 hugs:🤗 eyes:👀 see_no_evil:🙈 hear_no_evil:🙉 speak_no_evil:🙊 ' +
  'skull:💀 ghost:👻 robot:🤖 alien:👽 poop:💩 hankey:💩 clown_face:🤡 warning:⚠️ white_check_mark:✅️ ' +
  'heavy_check_mark:✔️ ballot_box_with_check:☑️ x:❌️ negative_squared_cross_mark:❎️ ' +
  'heavy_multiplication_x:✖️ heavy_plus_sign:➕️ heavy_minus_sign:➖️ question:❓️ grey_question:❔️ ' +
  'exclamation:❗️ grey_exclamation:❕️ heavy_exclamation_mark:❗️ bangbang:‼️ interrobang:⁉️ ' +
  'information_source:ℹ️ no_entry:⛔️ no_entry_sign:🚫 stop_sign:🛑 construction:🚧 rotating_light:🚨 ' +
  'triangular_flag_on_post:🚩 checkered_flag:🏁 red_circle:🔴 large_blue_circle:🔵 green_circle:🟢 ' +
  'yellow_circle:🟡 orange_circle:🟠 purple_circle:🟣 white_circle:⚪️ black_circle:⚫️ ' +
  'large_orange_diamond:🔶 large_blue_diamond:🔷 small_orange_diamond:🔸 small_blue_diamond:🔹 ' +
  'arrow_right:➡️ arrow_left:⬅️ arrow_up:⬆️ arrow_down:⬇️ arrow_forward:▶️ arrow_backward:◀️ ' +
  'arrows_counterclockwise:🔄 recycle:♻️ repeat:🔁 new:🆕 free:🆓 up:🆙 cool:🆒 ok:🆗 sos:🆘 top:🔝 soon:🔜 ' +
  'back:🔙 end:🔚 on:🔛 100:💯 1234:🔢 hash:#️⃣ zero:0️⃣ one:1️⃣ two:2️⃣ three:3️⃣ four:4️⃣ five:5️⃣ ' +
  'six:6️⃣ seven:7️⃣ eight:8️⃣ nine:9️⃣ keycap_ten:🔟 bug:🐛 sparkles:✨️ fire:🔥 zap:⚡️ boom:💥 bulb:💡 ' +
  'memo:📝 pencil:📝 pencil2:✏️ lock:🔒 unlock:🔓 key:🔑 closed_lock_with_key:🔐 star:⭐️ star2:🌟 dizzy:💫 ' +
  'wrench:🔧 hammer:🔨 hammer_and_wrench:🛠 gear:⚙️ package:📦 books:📚 book:📖 bookmark:🔖 link:🔗 ' +
  'paperclip:📎 pushpin:📌 scissors:✂️ mag:🔍 mag_right:🔎 chart_with_upwards_trend:📈 ' +
  'chart_with_downwards_trend:📉 bar_chart:📊 calendar:📆 date:📅 hourglass:⌛️ ' +
  'hourglass_flowing_sand:⏳️ stopwatch:⏱️ alarm_clock:⏰️ watch:⌚️ bell:🔔 no_bell:🔕 speech_balloon:💬 ' +
  'thought_balloon:💭 loudspeaker:📢 mega:📣 clipboard:📋 file_folder:📁 open_file_folder:📂 card_index:📇 ' +
  'page_facing_up:📄 page_with_curl:📃 scroll:📜 newspaper:📰 email:📧 envelope:✉️ inbox_tray:📥 ' +
  'outbox_tray:📤 mailbox:📫 globe_with_meridians:🌐 earth_americas:🌎 earth_africa:🌍 earth_asia:🌏 ' +
  'computer:💻 desktop_computer:🖥️ keyboard:⌨️ iphone:📱 floppy_disk:💾 cd:💿 dvd:📀 electric_plug:🔌 ' +
  'battery:🔋 flashlight:🔦 microscope:🔬 telescope:🔭 satellite:📡 test_tube:🧪 alembic:⚗️ dna:🧬 pill:💊 ' +
  'syringe:💉 ambulance:🚑 police_car:🚓 fire_engine:🚒 truck:🚚 ship:🚢 airplane:✈️ bike:🚲 car:🚗 taxi:🚕 ' +
  'bus:🚌 train2:🚆 anchor:⚓️ art:🎨 lipstick:💄 shield:🛡️ crossed_swords:⚔️ dagger:🗡️ bomb:💣 ' +
  'moneybag:💰 dollar:💵 euro:💶 money_with_wings:💸 gem:💎 credit_card:💳 chart:💹 coin:🪙 raised_hands:🙌 ' +
  'clap:👏 wave:👋 pray:🙏 muscle:💪 handshake:🤝 facepunch:👊 fist:✊️ v:✌️ crossed_fingers:🤞 ok_hand:👌 ' +
  'point_right:👉 point_left:👈 point_up:☝️ point_down:👇 point_up_2:👆 raised_hand:✋️ writing_hand:✍️ ' +
  'green_heart:💚 blue_heart:💙 purple_heart:💜 yellow_heart:💛 orange_heart:🧡 black_heart:🖤 ' +
  'white_heart:🤍 broken_heart:💔 sparkling_heart:💖 two_hearts:💕 heartpulse:💗 trophy:🏆 medal_sports:🏅 ' +
  '1st_place_medal:🥇 2nd_place_medal:🥈 3rd_place_medal:🥉 gift:🎁 balloon:🎈 confetti_ball:🎊 crown:👑 ' +
  'ribbon:🎀 coffee:☕️ tea:🍵 beer:🍺 beers:🍻 wine_glass:🍷 cocktail:🍸 pizza:🍕 hamburger:🍔 fries:🍟 ' +
  'cake:🍰 birthday:🎂 cookie:🍪 doughnut:🍩 apple:🍎 green_apple:🍏 banana:🍌 lemon:🍋 cherries:🍒 ' +
  'strawberry:🍓 grapes:🍇 watermelon:🍉 peach:🍑 snowflake:❄️ sunny:☀️ cloud:☁️ umbrella:☔️ rainbow:🌈 ' +
  'ocean:🌊 droplet:💧 sweat_drops:💦 seedling:🌱 herb:🌿 four_leaf_clover:🍀 evergreen_tree:🌲 ' +
  'deciduous_tree:🌳 palm_tree:🌴 cactus:🌵 tulip:🌷 rose:🌹 sunflower:🌻 cherry_blossom:🌸 fallen_leaf:🍂 ' +
  'leaves:🍃 mushroom:🍄 bee:🐝 snake:🐍 turtle:🐢 octopus:🐙 whale:🐳 dolphin:🐬 fish:🐟 tropical_fish:🐠 ' +
  'rabbit:🐰 cat:🐱 dog:🐶 unicorn:🦄 monkey:🐒 monkey_face:🐵 panda_face:🐼 bird:🐦 penguin:🐧 eagle:🦅 ' +
  'owl:🦉 bat:🦇 crab:🦀 lobster:🦞 snail:🐌 butterfly:🦋 busts_in_silhouette:👥 bust_in_silhouette:👤 ' +
  'construction_worker:👷 detective:🕵️ ninja:🥷 superhero:🦸 mage:🧙 vampire:🧛 zombie:🧟 white_flag:🏳️ ' +
  'black_flag:🏴 '

/** Shortcode name (without colons) → the emoji. */
export const EMOJI: ReadonlyMap<string, string> = new Map(
  TABLE.trim()
    .split(' ')
    .map((pair): [string, string] => {
      const at = pair.indexOf(':')
      return [pair.slice(0, at), pair.slice(at + 1)]
    }),
)
