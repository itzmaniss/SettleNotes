# Demo recording kit

This is the shot list for the 2 to 3 minute demo video. It follows the demo script in docs/PRD.md: pain, capture, first step done, loop, Meta tooling callout, close. The seeded demo data makes the dashboard look lived in; the live sends during recording show the real loop working.

Every bot reply below is the real wording the bot sends. Your dates will match the day you record.

## Before you record

1. Seed the demo user (dry run first, then write):

   ```
   bun run seed:demo
   bun run seed:demo -- --telegram-id <your id> --reset --yes
   ```

   Get your Telegram numeric id from @userinfobot. It must already be in `ALLOWED_TELEGRAM_IDS` in `.env`, otherwise the script refuses.

2. Start the bot and keep it running: `bun run bot:poll`.

3. `APP_BASE_URL` must be an https URL (your deployed URL or a quick tunnel such as `cloudflared`) or the replies have no "Open dashboard" button. Telegram rejects localhost buttons. Restart `bun run bot:poll` after changing `.env`.

4. Have the real assets ready and dropped into `tests/fixtures/real/understand/` (gitignored): at least one group chat screenshot, one assignment brief PDF, one lecture slides PDF, and a photo of handwritten math working where you know which step is wrong.

5. Keep `BILLING_ENABLED=false` so no quota reply interrupts a take.

6. Rehearse the math photo once before recording. The diagnosis runs at high reasoning effort and can take up to 200 seconds.

7. Record at 1920x1080. Telegram Desktop on the left, the dashboard in a browser on the right. Close other chats so notifications cannot photobomb.

## Shots

### 1. Pain (about 15 seconds)

On screen: a real group chat screenshot, scrolled slowly. Deadlines buried between memes.

Send: nothing yet.

Voiceover: "Every group chat is a second calendar you have to keep in your head. This is where deadlines go to hide."

### 2. Capture from the chat (about 40 seconds)

On screen: your Telegram DM with Settle.

Send: the group chat screenshot (forwarded or as a photo).

Bot reply, about 2 to 10 seconds later:

```
Added 3 tasks:
- CS2040 Lab 4 (due Wed 4 Nov, 11:59pm)
- MA2001 Problem Set 7 (due Fri 13 Nov, 11:59pm)
- EE2026 midterm (due Sun 8 Nov, 11:59pm)
```

One call creates every task it finds. The screenshot you use must mention the lab deadline, because the next line depends on it.

Send the text message: `prof say extend to nxt fri liao`

Bot reply:

```
Moved CS2040 Lab 4 to Fri 13 Nov, 11:59pm (was Wed 4 Nov, 11:59pm)
```

No duplicate task. If `APP_BASE_URL` is https there is also an "Open dashboard" button under the reply.

Voiceover: "Forward the chat, and Settle reads it. Singlish included: prof extended the lab, so the deadline moves instead of a duplicate appearing."

### 3. Brief to checklist (about 15 seconds)

On screen: the same Telegram chat.

Send: the assignment brief PDF as a document.

Bot reply:

```
Added 1 task:
- ST2334 project report (due Sat 7 Nov, 11:59pm)
I also made a checklist of 6 things to hand in. Tick them off on your dashboard.
```

Voiceover: "Thirty pages of brief become a checklist of what to actually hand in, with page references."

### 4. Slides to flashcards (about 15 seconds)

On screen: the same Telegram chat.

Send: the lecture slides PDF as a document.

Bot reply:

```
I also made 12 flashcards and 4 practice questions from your slides.
```

The count varies: real decks are 10 to 20 cards and 3 to 5 practice questions.

Voiceover: "Slides become flashcards and practice questions from your own course material, each tagged to the slide it came from."

### 5. Math photo (about 50 seconds)

On screen: the same Telegram chat.

Send: the photo of handwritten working, with a caption like `q4, expected answer 3840`.

Bot reply: your photo comes back with a red ring around the first wrong step and a caption like:

```
Step 3 is where it slipped: The chain rule was applied halfway. $\frac{dy}{du} = 5u^4$ is right, but the derivative of the inner function $u = 3x + 1$ was never multiplied in, so line 3 is missing the factor of 3.

Why it matters: Differentiates the outer function but forgets to multiply by the derivative of the inner function. (Chain rule)

Try this instead: Finish the chain rule: $\frac{dy}{dx} = \frac{dy}{du} \cdot \frac{du}{dx} = 5(3x + 1)^4 \cdot 3 = 15(3x + 1)^4$.
```

followed by a second message:

```
3 to try:
1. Differentiate $y = (2x + 3)^4$.
2. Differentiate $y = \sin(5x)$.
3. Differentiate $y = \ln(x^2 + 1)$.

Answers:
1. $y' = 4(2x + 3)^3 \cdot 2 = 8(2x + 3)^3$.
2. $y' = 5\cos(5x)$.
3. $y' = \frac{2x}{x^2 + 1}$.
```

The shape is always step, why it matters, try this. Live wording will differ slightly from this example; this exact text is what the seeded task carries.

and a third line appended:

```
This one keeps coming up, so I've added a quick review for tomorrow.
```

(The review line is the recurring variant because the seeded account has seen chain rule three times. A first-time miss says "I've added a review for <weekday> so this sticks." and lands 3 days out.)

This shot is the slow one, up to 200 seconds. Keep rolling; the bot shows "typing" the whole time.

Voiceover: "Send a photo of your working and Settle does not just say wrong. It circles the exact step where the reasoning slipped, names the misconception, and schedules practice on it."

### 5b. Voice note (optional, about 10 seconds, only if the video needs it)

On screen: the same Telegram chat.

Send: a voice note under 3 minutes with a deadline change in it, e.g. "eh EE2026 midterm changed, is next Saturday not Sunday".

Bot reply starts with what it heard, then the normal task summary:

```
I heard: "eh EE2026 midterm changed, is next Saturday not Sunday"

Moved EE2026 midterm to Sat 7 Nov, 11:59pm (was Sun 8 Nov, 11:59pm)
```

(A transcript that names a task you do not have yet adds it instead.)

Voiceover: "Or just talk. Voice notes come back as tasks too."

### 6. The loop on the dashboard (about 25 seconds)

On screen: the browser.

Send: `/dashboard` in the chat, then click the magic link it replies with.

Show, in this order:

- Home: tasks grouped Overdue, Today, This week, Later, with the seeded CS2040 Lab 4 and the fresh tasks from shots 2 to 5.
- Open CS2040 Lab 4: the history shows "Moved" with the evidence quote "prof say extend to nxt fri liao" right under the task.
- Tick one checklist item on the ST2334 report and show it sticking.
- Weak spots page: Chain rule 3 times with a review due tomorrow, Fractions 2 times, Sign errors 1 time.
- Back on home: the "Review: Chain rule" task sitting in This week.

Voiceover: "Everything lands in one calm list. The extension is recorded with the chat message that caused it, and mistakes come back as short reviews before the exam, not the night before."

### 7. Meta callout and close (about 25 seconds)

On screen: any of the previous screens, or the weak spots page.

Voiceover: "Every read runs on Meta's Muse Spark through the Model API: one model for chat screenshots, PDFs and photos of working. Structured output keeps its answers machine-checkable. Reasoning effort scales per job, cheap reads for texts, full effort for math. And the grounding grid is what lets it circle the wrong step on your own photo. Standard mode, so student work never trains Meta's models."

Close on the dashboard home, then:

Voiceover: "Settle. Give students back the energy they spend remembering what to do."

## What can go wrong

- Math is slow. High effort can take up to 200 seconds. Do not restart the send; keep rolling.
- Blurry math photo. The reply becomes "Sorry, I couldn't read that one. Could you send a clearer photo or the PDF instead?" Have a sharper photo ready and reshoot.
- No "Open dashboard" button. `APP_BASE_URL` is http or localhost. Point it at the deployed https URL or a tunnel, restart `bot:poll`, reseed nothing.
- A quota sentence appears. Only happens with `BILLING_ENABLED=true`. Keep it false while recording.
- Voice note too long or too quiet. Over 3 minutes gets "That voice note is a bit long for me. Could you send one under 3 minutes?" and silence gets "I couldn't hear anything in that voice note. Could you try again a bit closer to the mic?" Keep the spare voice note short and close to the mic.
- The extend line creates a new task instead of moving one. The screenshot's lab title did not match closely enough. Make the screenshot name the task the same way your list does.
- Daily budget hit. The bot replies "My daily reading limit is used up..." Rehearsals plus takes can add up; each full run of this script costs a few cents to about $0.15.

## Assets you still need to provide

Agents cannot fabricate these. Marked clearly so nothing is assumed:

- Real group chat screenshots with Singlish deadline chatter (can be staged with friends). Needed for shots 1 and 2.
- One assignment brief PDF, ideally 10 or more pages. Needed for shot 3.
- One lecture slides PDF for a topic you can talk about. Needed for shot 4.
- Photos of handwritten math working with a known wrong step, labelled on paper or in a note for yourself. Needed for shot 5.
- One voice note you are willing to record live. Needed only for the optional shot 5b.
