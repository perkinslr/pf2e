import type { CharacterPF2e } from "@actor";
import { CharacterAttributesSource, CharacterResourcesSource } from "@actor/character/data.ts";
import { ChatMessageSourcePF2e } from "@module/chat-message/data.ts";
import { ChatMessagePF2e } from "@module/chat-message/index.ts";
import { ActionDefaultOptions } from "@system/action-macros/index.ts";
import { localizer, tupleHasValue } from "@util";
import { Duration } from "luxon";

interface RestForTheNightOptions extends ActionDefaultOptions {
    skipDialog?: boolean;
}

/** A macro for the Rest for the Night quasi-action */
export async function restForTheNight(options: RestForTheNightOptions): Promise<ChatMessagePF2e[]> {
    const actors = Array.isArray(options.actors) ? options.actors : [options.actors];
    const characters = actors.filter((a): a is CharacterPF2e => a?.type === "character");
    if (actors.length === 0) {
        ui.notifications.error(game.i18n.localize("PF2E.ErrorMessage.NoPCTokenSelected"));
        return [];
    }
    const localize = localizer("PF2E.Action.RestForTheNight");
    const promptMessage = ((): string => {
        const element = document.createElement("p");
        element.innerText = localize("Prompt");
        return element.outerHTML;
    })();
    if (
        !options.skipDialog &&
        !(await Dialog.confirm({
            title: localize("Label"),
            content: promptMessage,
            defaultYes: true,
        }))
    ) {
        return [];
    }

    const messages: PreCreate<ChatMessageSourcePF2e>[] = [];

    for (const actor of characters) {
        const actorUpdates: ActorUpdates = {
            attributes: { hp: { value: actor._source.system.attributes.hp.value } },
            resources: {},
        };
        const itemUpdates: EmbeddedDocumentUpdateData[] = [];
        // A list of messages informing the user of updates made due to rest
        const statements: string[] = [];

        const { abilities, attributes, hitPoints, level } = actor;

        // Hit points
        const conModifier = abilities.con.mod;
        const maxRestored = Math.max(conModifier, 1) * level * hitPoints.recoveryMultiplier + hitPoints.recoveryAddend;
        const hpLost = attributes.hp.max - attributes.hp.value;
        const hpRestored = hpLost >= maxRestored ? maxRestored : hpLost;
        if (hpRestored > 0) {
            const singularOrPlural =
                hpRestored === 1
                    ? "PF2E.Action.RestForTheNight.Message.HitPointsSingle"
                    : "PF2E.Action.RestForTheNight.Message.HitPoints";
            actorUpdates.attributes.hp = { value: (attributes.hp.value += hpRestored) };
            statements.push(game.i18n.format(singularOrPlural, { hitPoints: hpRestored }));
        }

        // Conditions
        const RECOVERABLE_CONDITIONS = ["doomed", "drained", "fatigued", "wounded"] as const;
        const conditionChanges: Record<(typeof RECOVERABLE_CONDITIONS)[number], "removed" | "reduced" | null> = {
            doomed: null,
            drained: null,
            fatigued: null,
            wounded: null,
        };

        // Fatigued condition
        if (actor.hasCondition("fatigued")) {
            await actor.decreaseCondition("fatigued");
            conditionChanges.fatigued = "removed";
        }

        // Doomed and Drained conditions
        for (const slug of ["doomed", "drained"] as const) {
            const condition = actor.getCondition(slug);
            if (!condition) continue;

            const newValue = (condition.value ?? 1) - 1;
            await actor.decreaseCondition(slug);
            conditionChanges[slug] = newValue === 0 ? "removed" : "reduced";
        }

        if (actor.hasCondition("wounded") && attributes.hp.value === attributes.hp.max) {
            await actor.decreaseCondition("wounded", { forceRemove: true });
            conditionChanges.wounded = "removed";
        }

        // Restore wand charges
        const items = actor.itemTypes;
        const wands = items.consumable.filter((i) => i.category === "wand" && i.uses.value < i.uses.max);
        itemUpdates.push(...wands.map((wand) => ({ _id: wand.id, "system.uses.value": wand.uses.max })));
        const wandRecharged = itemUpdates.length > 0;

        // Restore reagents
        const resources = actor.system.resources;
        const reagents = resources.crafting.infusedReagents;
        if (reagents && reagents.value < reagents.max) {
            actorUpdates.resources.crafting = { infusedReagents: { value: reagents.max } };
            statements.push(localize("Message.InfusedReagents"));
        }

        // Spellcasting entries and focus points
        const spellcastingRecharge = actor.spellcasting.recharge();
        itemUpdates.push(...spellcastingRecharge.itemUpdates);
        if (spellcastingRecharge.actorUpdates?.["system.resources.focus.value"]) {
            actorUpdates.resources.focus = {
                value: spellcastingRecharge.actorUpdates?.["system.resources.focus.value"],
            };
        }

        // Action Frequencies
        const actionsAndFeats = [...actor.itemTypes.action, ...actor.itemTypes.feat];
        const withFrequency = actionsAndFeats.filter(
            (a) =>
                a.frequency &&
                (tupleHasValue(["turn", "round", "day"], a.frequency.per) ||
                    Duration.fromISO(a.frequency.per) <= Duration.fromISO("PT8H")) &&
                a.frequency.value < a.frequency.max,
        );
        if (withFrequency.length > 0) {
            statements.push(localize("Message.Frequencies"));
            itemUpdates.push(
                ...withFrequency.map((a) => ({ _id: a.id, "system.frequency.value": a.frequency?.max ?? 0 })),
            );
        }

        // Stamina points
        if (game.pf2e.settings.variants.stamina) {
            const stamina = attributes.hp.sp ?? { value: 0, max: 0 };
            const damageTaken = attributes.hp.dt ?? { value: 0 };
            const resolve = resources.resolve ?? { value: 0, max: 0 };
            if (stamina.value < stamina.max) {
                actorUpdates.attributes.hp.sp = { value: stamina.max };
                statements.push(localize("Message.StaminaPoints"));
            }
            if (damageTaken.value > 0) {
                const ndt = Math.max(0, damageTaken.value - maxRestored * 4);
                actorUpdates.attributes.hp.dt = { value: ndt };
                const tmhp = Math.floor(attributes.hp.max - ndt / 2);
                statements.push(localize("Message.TotalDamageTaken", {tmpMaxHP: tmhp}));
                if (actorUpdates.attributes.hp.value > tmhp) {
                    actorUpdates.attributes.hp.value = tmhp;
                }
            }
            if (resolve.value < resolve.max) {
                actorUpdates.resources.resolve = { value: resolve.max };
                statements.push(localize("Message.Resolve"));
            }
        }

        // Collect temporary crafted items to remove
        const temporaryItems = actor.inventory.filter((i) => i.isTemporary).map((i) => i.id);
        const hasActorUpdates = Object.keys({ ...actorUpdates.attributes, ...actorUpdates.resources }).length > 0;
        const hasItemUpdates = itemUpdates.length > 0;
        const removeTempItems = temporaryItems.length > 0;

        // Updated actor with the sweet fruits of rest
        if (hasActorUpdates) {
            await actor.update({ system: actorUpdates }, { render: false });
        }

        if (hasItemUpdates) {
            await actor.updateEmbeddedDocuments("Item", itemUpdates, { render: false });
        }

        if (removeTempItems) {
            await actor.deleteEmbeddedDocuments("Item", temporaryItems, { render: false });
            statements.push(localize("Message.TemporaryItems"));
        }

        if (spellcastingRecharge.actorUpdates) {
            statements.push(localize("Message.FocusPoints"));
        }

        if (spellcastingRecharge.itemUpdates.length > 0) {
            statements.push(localize("Message.SpellSlots"));
        }

        // Wand recharge
        if (wandRecharged) {
            statements.push(localize("Message.WandsCharges"));
        }

        // Conditions removed
        const reducedConditions = RECOVERABLE_CONDITIONS.filter((c) => conditionChanges[c] === "reduced");
        for (const slug of reducedConditions) {
            const { name } = game.pf2e.ConditionManager.getCondition(slug);
            statements.push(localize("Message.ConditionReduced", { condition: name }));
        }

        // Condition value reduction
        const removedConditions = RECOVERABLE_CONDITIONS.filter((c) => conditionChanges[c] === "removed");
        for (const slug of removedConditions) {
            const { name } = game.pf2e.ConditionManager.getCondition(slug);
            statements.push(localize("Message.ConditionRemoved", { condition: name }));
        }

        // Send chat message with results
        const actorAwakens = localize("Message.Awakens", { actor: actor.name });
        const recoveryList = document.createElement("ul");
        recoveryList.append(
            ...statements.map((statement): HTMLLIElement => {
                const listItem = document.createElement("li");
                listItem.innerText = statement;
                return listItem;
            }),
        );
        const content = [actorAwakens, recoveryList.outerHTML].join("\n");

        // Call a hook for modules to do anything extra
        Hooks.callAll("pf2e.restForTheNight", actor);
        messages.push({ author: game.user.id, content, speaker: ChatMessagePF2e.getSpeaker({ actor }) });
    }

    return ChatMessagePF2e.createDocuments(messages, { restForTheNight: true });
}

interface ActorUpdates {
    attributes: DeepPartial<CharacterAttributesSource> & { hp: { value: number } };
    resources: DeepPartial<CharacterResourcesSource>;
}
