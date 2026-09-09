import derouter


class Rules:
    """
    Fail calls based on the input or llm api output

    Example usage:
    import derouter
    def my_custom_rule(input): # receives the model response
            if "i don't think i can answer" in input: # trigger fallback if the model refuses to answer
                    return False
            return True

    derouter.post_call_rules = [my_custom_rule] # have these be functions that can be called to fail a call

    response = derouter.completion(model="gpt-3.5-turbo", messages=[{"role": "user",
        "content": "Hey, how's it going?"}], fallbacks=["openrouter/mythomax"])
    """

    def __init__(self) -> None:
        pass

    @staticmethod
    def has_pre_call_rules() -> bool:
        """Check if any pre-call rules are configured"""
        return len(derouter.pre_call_rules) > 0

    def pre_call_rules(self, input: str, model: str):
        for rule in derouter.pre_call_rules:
            if callable(rule):
                decision = rule(input)
                if decision is False:
                    raise derouter.APIResponseValidationError(
                        message="LLM Response failed post-call-rule check",
                        llm_provider="",
                        model=model,
                    )
        return True

    def post_call_rules(self, input: str | None, model: str) -> bool:
        if input is None:
            return True
        for rule in derouter.post_call_rules:
            if callable(rule):
                decision = rule(input)
                if isinstance(decision, bool):
                    if decision is False:
                        raise derouter.APIResponseValidationError(
                            message="LLM Response failed post-call-rule check",
                            llm_provider="",
                            model=model,
                        )
                elif isinstance(decision, dict):
                    decision_val = decision.get("decision", True)
                    decision_message = decision.get("message", "LLM Response failed post-call-rule check")
                    if decision_val is False:
                        raise derouter.APIResponseValidationError(message=decision_message, llm_provider="", model=model)
        return True
