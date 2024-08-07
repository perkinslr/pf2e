import { ChatMessagePF2e } from "@module/chat-message/index.ts";
import { CheckRoll } from "@system/check/roll.ts";
import { htmlQuery } from "@util";

/** Highlight critical success or failure on d20 rolls */
export const DegreeOfSuccessHighlights = {
    listen: (message: ChatMessagePF2e, html: HTMLElement): void => {
        const firstRoll = message.rolls[0];
        const shouldHighlight =
            firstRoll instanceof CheckRoll &&
            message.isContentVisible &&
            (game.user.isGM || firstRoll.options.showBreakdown) &&
            !html.querySelector(".reroll-indicator");
        if (!shouldHighlight) return;

        const firstDice = firstRoll.dice.at(0);
        if (!(firstDice instanceof foundry.dice.terms.Die && ((firstDice.faces === 6 && firstDice.number === 3) || firstDice.faces === 20))) {
            return;
        }

        const diceTotal = htmlQuery(html, ".dice-total");
        const results = firstDice.results.filter((r) => r.active);
        if (results.every((r) => r.result === firstDice.faces * firstDice.number)) {
            diceTotal?.classList.add("success");
        } else if (results.every((r) => r.result === firstDice.number)) {
            diceTotal?.classList.add("failure");
        }
    },
};
