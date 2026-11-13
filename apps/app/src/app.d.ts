/** ST DOM-contract attributes (DEV_NOTES §9.3) used on our elements. */
declare namespace svelteHTML {
  interface HTMLAttributes<T> {
    mesid?: number | string;
    is_user?: boolean | string;
    ch_name?: string;
    /** ST .select_chat_block / .PastChat_cross */
    file_name?: string;
    /** ST .character_select[chid] / .group_select[grid] */
    chid?: string | number;
    grid?: string;
  }
}
